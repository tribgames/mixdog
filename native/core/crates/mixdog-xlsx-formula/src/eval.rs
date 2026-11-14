//! The evaluator of the formula engine (`evaluateFormula` and what it calls in `portable/xlsx-formula-engine.mjs`):
//! Excel's coercions and error values, references resolved through the caller's [`Context`], and a refusal for
//! everything the engine cannot stand behind. A formula this engine cannot read is refused, never guessed: a wrong
//! number inside a model is worse than a cell the reader can see was never calculated.

use std::cmp::Ordering;

use mixdog_js::time::{local_fields, utc_to_ms};
use mixdog_js::{js_trim, math, number_to_string, string_to_number};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};

use crate::coerce::{compare_utf16, to_js_string, wall_clock_ms};
use crate::parse::{BinaryOperator, Node, parse};
use crate::registry::{Registry, library};
use crate::value::{ErrorValue, Failure, Value};

/// A range larger than this many cells is refused.
pub const MAX_RANGE_CELLS: f64 = 200_000.0;
/// How deep the evaluation of a formula may nest (a defined name that is a formula adds its own levels).
const MAX_EVALUATION_DEPTH: usize = 600;
const DAY_MS: f64 = 86_400_000.0;

/// A function that answers for an error argument instead of inheriting it: `IF` and its family choose a branch, and
/// the `IS` tests report on the error itself.
const ERROR_TOLERANT: [&str; 11] =
    ["IF", "IFS", "IFERROR", "IFNA", "ISERROR", "ISERR", "ISNA", "ERROR.TYPE", "CHOOSE", "SWITCH", "NA"];

/// Excel matches `"가*"` against the cells of a range; the library compares the criterion as written and quietly counts
/// nothing. A count of nothing looks like an answer, so these are refused instead.
const CRITERIA_FUNCTIONS: [&str; 8] =
    ["COUNTIF", "COUNTIFS", "SUMIF", "SUMIFS", "AVERAGEIF", "AVERAGEIFS", "MAXIFS", "MINIFS"];

/// These answer about where a reference sits. This engine hands a function the value of a cell rather than the cell
/// itself, so their answer would describe something else entirely.
const NEEDS_REFERENCE: [&str; 8] = ["ROW", "COLUMN", "OFFSET", "INDIRECT", "ADDRESS", "CELL", "AREAS", "FORMULATEXT"];

/// The used extent of a sheet, in rows and columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extent {
    pub rows: u64,
    pub columns: u64,
}

/// What a formula is evaluated against: the workbook around its cell.
pub trait Context {
    /// The sheet the formula sits on, which a reference without a sheet name means.
    fn sheet(&self) -> &str;

    /// The value of one cell (`A1`, upper case, no `$`) of a sheet: it may recurse into the evaluation of that cell's
    /// own formula, and it fails with the refusal that evaluation ends in.
    fn value(&mut self, sheet: &str, reference: &str) -> Result<Value, Failure>;

    /// The rows and columns a sheet uses, which bounds a whole-column or whole-row reference. A workbook that cannot say
    /// leaves the default, and such a reference is refused.
    fn extent(&mut self, _sheet: &str) -> Option<Extent> {
        None
    }

    /// What a workbook name stands for, written as a formula. A name with no definition (or an empty one) is refused.
    fn defined_name(&mut self, _name: &str) -> Option<String> {
        None
    }
}

fn refuse(reason: impl Into<String>) -> Failure {
    Failure::unsupported(reason)
}

/// A named sheet, quoted by Excel when it needs it (a doubled quote is one quote of the name).
struct SplitReference {
    sheet: String,
    from: String,
    to: String,
}

fn split_reference(text: &str) -> SplitReference {
    let (sheet, body) = match text.rfind('!') {
        None => (String::new(), text),
        Some(bang) => {
            let name = &text[..bang];
            let name = name.strip_prefix('\'').unwrap_or(name);
            let name = name.strip_suffix('\'').unwrap_or(name);
            (name.replace("''", "'"), &text[bang + 1..])
        }
    };
    let body = body.replace('$', "").to_uppercase();
    let mut parts = body.splitn(3, ':');
    let from = parts.next().unwrap_or_default().to_owned();
    let to = parts.next().unwrap_or_default().to_owned();
    SplitReference { sheet, from, to }
}

fn is_column_only(text: &str) -> bool {
    (1..=3).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_uppercase())
}

fn is_row_only(text: &str) -> bool {
    (1..=7).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

struct Corners {
    first_column: f64,
    last_column: f64,
    first_row: u64,
    last_row: u64,
}

fn row_number(text: &str) -> u64 {
    text.parse().unwrap_or(u64::MAX)
}

/// `A:A` names a column of a million rows, of which the sheet uses a few. Excel answers from its used range, so this
/// engine asks the workbook for that extent and refuses when nothing can tell it: a million empty cells is not an
/// answer worth writing into a model.
fn range_corners(sheet: &str, from: &str, to: &str, context: &mut dyn Context) -> Result<Corners, Failure> {
    if is_column_only(from) && is_column_only(to) {
        let Some(extent) = context.extent(sheet) else {
            return Err(refuse("a whole-column reference without a known used range"));
        };
        let (a, b) = (column_number(from), column_number(to));
        return Ok(Corners { first_column: math::min(a, b), last_column: math::max(a, b), first_row: 1, last_row: extent.rows.max(1) });
    }
    if is_row_only(from) && is_row_only(to) {
        let Some(extent) = context.extent(sheet) else {
            return Err(refuse("a whole-row reference without a known used range"));
        };
        let (a, b) = (row_number(from), row_number(to));
        return Ok(Corners { first_column: 1.0, last_column: extent.columns.max(1) as f64, first_row: a.min(b), last_row: a.max(b) });
    }
    let start = parse_cell_ref(from).map_err(Failure::Thrown)?;
    let end = parse_cell_ref(to).map_err(Failure::Thrown)?;
    let (a, b) = (column_number(&start.col), column_number(&end.col));
    Ok(Corners {
        first_column: math::min(a, b),
        last_column: math::max(a, b),
        first_row: start.row.min(end.row),
        last_row: start.row.max(end.row),
    })
}

fn range_values(sheet: &str, from: &str, to: &str, context: &mut dyn Context) -> Result<Value, Failure> {
    let corners = range_corners(sheet, from, to, context)?;
    let columns = corners.last_column - corners.first_column + 1.0;
    let rows = (corners.last_row as f64) - (corners.first_row as f64) + 1.0;
    if columns * rows > MAX_RANGE_CELLS {
        return Err(refuse("the range is larger than this engine evaluates"));
    }
    let mut lines = Vec::with_capacity(rows as usize);
    for row in corners.first_row..=corners.last_row {
        let mut line = Vec::with_capacity(columns as usize);
        let mut column = corners.first_column;
        while column <= corners.last_column {
            line.push(context.value(sheet, &format!("{}{row}", column_label(column)))?.canonical());
            column += 1.0;
        }
        lines.push(Value::Array(line));
    }
    Ok(Value::Array(lines))
}

/// Excel would take the implicit intersection here; this engine does not guess which cell the author meant.
fn single(value: Value) -> Result<Value, Failure> {
    if matches!(value, Value::Array(_)) { Err(refuse("a range used where one value is expected")) } else { Ok(value) }
}

/// `toNumber(value)`: blank is 0, text is its number; an error is itself and text that is no number is `#VALUE!`.
fn to_number(value: &Value) -> Result<f64, ErrorValue> {
    if value.is_blank() {
        return Ok(0.0);
    }
    match value {
        Value::Number(number) => Ok(*number),
        Value::Bool(flag) => Ok(f64::from(u8::from(*flag))),
        Value::Error(error) => Err(*error),
        other => {
            let numeric = string_to_number(js_trim(&to_js_string(other)));
            if numeric.is_finite() { Ok(numeric) } else { Err(ErrorValue::Value) }
        }
    }
}

fn to_text(value: &Value) -> String {
    match value {
        Value::Undefined | Value::Null => String::new(),
        Value::Bool(flag) => (if *flag { "TRUE" } else { "FALSE" }).to_owned(),
        Value::Number(number) => number_to_string(*number),
        other => to_js_string(other),
    }
}

/// `ordering(x, y)` of numbers: 0 when equal, else -1 or 1 (1 for an unordered pair).
fn number_ordering(x: f64, y: f64) -> i8 {
    if x == y {
        0
    } else if x < y {
        -1
    } else {
        1
    }
}

fn arithmetic(operator: BinaryOperator, left: Value, right: Value) -> Result<Value, Failure> {
    let a = match to_number(&single(left)?) {
        Ok(number) => number,
        Err(error) => return Ok(Value::Error(error)),
    };
    let b = match to_number(&single(right)?) {
        Ok(number) => number,
        Err(error) => return Ok(Value::Error(error)),
    };
    Ok(Value::Number(match operator {
        BinaryOperator::Add => a + b,
        BinaryOperator::Subtract => a - b,
        BinaryOperator::Multiply => a * b,
        BinaryOperator::Divide => {
            if b == 0.0 {
                return Ok(Value::Error(ErrorValue::Div0));
            }
            a / b
        }
        _ => {
            let power = math::pow(a, b);
            if !power.is_finite() {
                return Ok(Value::Error(ErrorValue::Num));
            }
            power
        }
    }))
}

fn compare(operator: BinaryOperator, left: Value, right: Value) -> Result<Value, Failure> {
    let a = single(left)?;
    let b = single(right)?;
    let mut order = None;
    if matches!(a, Value::Number(_)) || matches!(b, Value::Number(_)) {
        if let (Ok(x), Ok(y)) = (to_number(&a), to_number(&b)) {
            order = Some(number_ordering(x, y));
        }
    }
    let order = order.unwrap_or_else(|| match compare_utf16(&to_text(&a).to_uppercase(), &to_text(&b).to_uppercase()) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    });
    Ok(Value::Bool(match operator {
        BinaryOperator::Equal => order == 0,
        BinaryOperator::NotEqual => order != 0,
        BinaryOperator::Less => order < 0,
        BinaryOperator::Greater => order > 0,
        BinaryOperator::LessOrEqual => order <= 0,
        _ => order >= 0,
    }))
}

fn apply(operator: BinaryOperator, left: Value, right: Value) -> Result<Value, Failure> {
    match operator {
        BinaryOperator::Concat => {
            Ok(Value::Text(format!("{}{}", to_text(&single(left)?), to_text(&single(right)?))).canonical())
        }
        BinaryOperator::Equal
        | BinaryOperator::NotEqual
        | BinaryOperator::Less
        | BinaryOperator::Greater
        | BinaryOperator::LessOrEqual
        | BinaryOperator::GreaterOrEqual => compare(operator, left, right),
        _ => arithmetic(operator, left, right),
    }
}

/// Excel's own epoch: day 1 is 1900-01-01 and the calendar keeps its 1900 leap-day bug, which puts the zero point at
/// 1899-12-30.
fn excel_epoch_ms() -> f64 {
    utc_to_ms(1899, 12, 30, 0, 0, 0, 0)
}

/// A serial counts calendar days, and the library builds its dates at local midnight: reading the UTC instant instead
/// of the wall-clock parts stores 31 January as 30 January plus fifteen hours on a machine east of UTC, and every
/// function that reads the serial back then answers for the wrong day.
fn excel_serial(time: f64, parsed_from_text: bool) -> Value {
    if time.is_nan() {
        return Value::Error(ErrorValue::Value);
    }
    // A date the library read out of text sits at UTC midnight rather than local midnight, and reading it by its wall
    // clock would move it into the next day.
    if parsed_from_text {
        return Value::Number((time - excel_epoch_ms()) / DAY_MS);
    }
    let Some(fields) = local_fields(time) else { return Value::Error(ErrorValue::Value) };
    let wall_clock = wall_clock_ms(
        i64::from(fields.year),
        i64::from(fields.month),
        i64::from(fields.day),
        i64::from(fields.hour),
        i64::from(fields.minute),
        i64::from(fields.second),
        i64::from(fields.millisecond),
    );
    Value::Number((wall_clock - excel_epoch_ms()) / DAY_MS)
}

/// A library result speaks JavaScript; a worksheet stores Excel's own shapes.
fn normalize(value: Value, parsed_from_text: bool) -> Result<Value, Failure> {
    Ok(match value {
        Value::Date(time) => excel_serial(time, parsed_from_text),
        Value::Error(error) if error.is_cell_error() => Value::Error(error),
        Value::Error(_) => Value::Error(ErrorValue::Value),
        Value::Undefined => Value::Text(String::new()),
        Value::Number(number) if !number.is_finite() => Value::Error(ErrorValue::Num),
        Value::Array(_) => return Err(refuse("a function that answers with an array")),
        other => other.canonical(),
    })
}

/// Every date the library builds stands at local midnight, except the one it reads out of text, which stands at UTC
/// midnight instead.
const TEXT_PARSED_DATE: [&str; 1] = ["DATEVALUE"];

/// The format code of `TEXT` without its quoted parts and its escaped characters (`unquotedFormat`).
fn unquoted_format(text: &str) -> String {
    let mut without_quotes = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        match rest[open + 1..].find('"') {
            Some(close) => {
                without_quotes.push_str(&rest[..open]);
                rest = &rest[open + 1 + close + 1..];
            }
            None => break,
        }
    }
    without_quotes.push_str(rest);
    // `/\\./g`: a backslash and the character after it, unless that is a line terminator.
    let mut out = String::new();
    let mut chars = without_quotes.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|next| !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}')) {
            chars.next();
        } else {
            out.push(c);
        }
    }
    out
}

/// The library reads a serial as a plain number and renders a date as the day before it in this time zone, so a date
/// format code has no answer here worth writing into a cell. A number format has one, and keeps working.
fn has_date_format_token(format: &str) -> bool {
    unquoted_format(format).chars().any(|c| matches!(c.to_ascii_lowercase(), 'y' | 'm' | 'd' | 'h' | 's'))
}

/// `/(?:^|[^~])[*?]/`: a `*` or `?` that is not escaped by a `~` before it.
fn has_wildcard(text: &str) -> bool {
    let mut previous: Option<char> = None;
    for c in text.chars() {
        if (c == '*' || c == '?') && previous != Some('~') {
            return true;
        }
        previous = Some(c);
    }
    false
}

/// What a string-typed argument is in the Node engine, where an error is its text.
fn string_argument(value: &Value) -> Option<&str> {
    match value {
        Value::Text(text) => Some(text),
        Value::Error(error) if error.is_cell_error() => Some(error.message()),
        _ => None,
    }
}

struct Evaluator<'a> {
    registry: &'a Registry,
    context: &'a mut dyn Context,
    depth: usize,
}

impl Evaluator<'_> {
    fn evaluate_node(&mut self, node: &Node) -> Result<Value, Failure> {
        self.depth += 1;
        let result = if self.depth > MAX_EVALUATION_DEPTH {
            Err(refuse("the formula nests deeper than this engine evaluates"))
        } else {
            self.evaluate_inner(node)
        };
        self.depth -= 1;
        result
    }

    fn evaluate_inner(&mut self, node: &Node) -> Result<Value, Failure> {
        match node {
            Node::Literal(value) => Ok(value.clone()),
            Node::Reference(text) => {
                let SplitReference { sheet, from, to } = split_reference(text);
                let target = if sheet.is_empty() { self.context.sheet().to_owned() } else { sheet };
                if to.is_empty() {
                    Ok(self.context.value(&target, &from)?.canonical())
                } else {
                    range_values(&target, &from, &to, self.context)
                }
            }
            // A name the workbook defines as a cell, a range or a constant is that value under another word, and it is
            // read exactly as the definition is written. A name defined as anything else (including one scoped to a
            // single sheet) has no reading here and is refused.
            Node::Name(text) => {
                let Some(target) = self.context.defined_name(text).filter(|target| !target.is_empty()) else {
                    return Err(refuse(format!("defined name {text}")));
                };
                let tree = parse(target.strip_prefix('=').unwrap_or(&target))?;
                self.evaluate_node(&tree)
            }
            Node::Percent { operand, count } => {
                let value = single(self.evaluate_node(operand)?)?;
                match to_number(&value) {
                    Err(error) => Ok(Value::Error(error)),
                    Ok(mut number) => {
                        for _ in 0..*count {
                            number /= 100.0;
                        }
                        Ok(Value::Number(number))
                    }
                }
            }
            Node::Unary { negations, operand } => {
                let value = single(self.evaluate_node(operand)?)?;
                match to_number(&value) {
                    Err(error) => Ok(Value::Error(error)),
                    Ok(mut number) => {
                        for negative in negations.iter().rev() {
                            if *negative {
                                number = -number;
                            }
                        }
                        Ok(Value::Number(number))
                    }
                }
            }
            Node::Chain { first, rest } => {
                let mut left = self.evaluate_node(first)?;
                for (operator, operand) in rest {
                    if left.is_formula_error() {
                        return Ok(left);
                    }
                    let right = self.evaluate_node(operand)?;
                    if right.is_formula_error() {
                        return Ok(right);
                    }
                    left = apply(*operator, left, right)?;
                }
                Ok(left)
            }
            Node::Call { name, args } => self.evaluate_call(name, args),
        }
    }

    fn evaluate_call(&mut self, name: &str, nodes: &[Node]) -> Result<Value, Failure> {
        // An empty cell arrives here as empty text, so ISBLANK would call a blank cell filled. Excel's answer is TRUE,
        // and guessing FALSE is worse than leaving the cell for LibreOffice.
        if name == "ISBLANK" {
            return Err(refuse("ISBLANK, which cannot tell an empty cell from empty text here"));
        }
        if NEEDS_REFERENCE.contains(&name) {
            return Err(refuse(format!("{name}, which answers about a cell this engine reads as a value")));
        }
        let Some(implementation) = self.registry.resolve(name) else {
            return Err(refuse(format!("{name} is not implemented")));
        };
        let mut args = Vec::with_capacity(nodes.len());
        for node in nodes {
            args.push(self.evaluate_node(node)?);
        }
        if name == "TEXT" {
            let format = args.get(1).map_or_else(
                || "undefined".to_owned(),
                |value| string_argument(value).map_or_else(|| to_js_string(value), str::to_owned),
            );
            if has_date_format_token(&format) {
                return Err(refuse("TEXT with a date format, which this engine cannot render"));
            }
        }
        if CRITERIA_FUNCTIONS.contains(&name) && args.iter().any(|value| string_argument(value).is_some_and(has_wildcard)) {
            return Err(refuse(format!("{name} with a wildcard criterion, which this engine does not match")));
        }
        if !ERROR_TOLERANT.contains(&name) {
            if let Some(failed) = args.iter().find(|value| value.is_formula_error()) {
                return Ok(failed.clone());
            }
        }
        normalize(implementation(&args)?, TEXT_PARSED_DATE.contains(&name))
    }
}

/// The value of one formula, read in the context of its own sheet, with the functions of the whole library.
/// `context.value(sheet, reference)` answers with a cell's value and may recurse. Fails with a refusal when the formula
/// is outside what this engine reads.
pub fn evaluate_formula(formula: &str, context: &mut dyn Context) -> Result<Value, Failure> {
    evaluate_formula_with(library(), formula, context)
}

/// [`evaluate_formula`] with the functions of `registry`.
pub fn evaluate_formula_with(registry: &Registry, formula: &str, context: &mut dyn Context) -> Result<Value, Failure> {
    let text = formula.strip_prefix('=').unwrap_or(formula);
    if js_trim(text).is_empty() {
        return Err(refuse("the formula is empty"));
    }
    // `/\[[^\]]*\]/`: a bracket that is closed later.
    if text.find('[').is_some_and(|open| text[open..].contains(']')) {
        return Err(refuse("a workbook or table reference"));
    }
    let tree = parse(text)?;
    let mut evaluator = Evaluator { registry, context, depth: 0 };
    let value = evaluator.evaluate_node(&tree)?;
    normalize(value, false)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::coerce::flatten;
    use crate::registry::Table;

    struct Cells {
        sheet: &'static str,
        cells: HashMap<(String, String), Value>,
        names: HashMap<String, String>,
        extent: Option<Extent>,
        asked: Vec<String>,
    }

    impl Cells {
        fn new() -> Self {
            let mut cells = HashMap::new();
            for (reference, value) in [
                ("A1", Value::Number(2.0)),
                ("A2", Value::Number(3.0)),
                ("B1", Value::text("north")),
                ("C1", Value::Bool(true)),
                ("D1", Value::text("#N/A")),
            ] {
                cells.insert(("Sheet1".to_owned(), reference.to_owned()), value);
            }
            cells.insert(("Raw Data".to_owned(), "B2".to_owned()), Value::Number(21.0));
            Self { sheet: "Sheet1", cells, names: HashMap::new(), extent: None, asked: Vec::new() }
        }
    }

    impl Context for Cells {
        fn sheet(&self) -> &str {
            self.sheet
        }

        fn value(&mut self, sheet: &str, reference: &str) -> Result<Value, Failure> {
            self.asked.push(format!("{sheet}!{reference}"));
            Ok(self.cells.get(&(sheet.to_owned(), reference.to_owned())).cloned().unwrap_or_else(|| Value::text("")))
        }

        fn extent(&mut self, _sheet: &str) -> Option<Extent> {
            self.extent
        }

        fn defined_name(&mut self, name: &str) -> Option<String> {
            self.names.get(name).cloned()
        }
    }

    fn sum(args: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Number(flatten(args).iter().filter_map(|value| if let Value::Number(n) = value { Some(*n) } else { None }).sum()))
    }

    fn if_function(args: &[Value]) -> Result<Value, Failure> {
        let truthy = args.first().is_some_and(crate::coerce::is_truthy);
        Ok(args.get(if truthy { 1 } else { 2 }).cloned().unwrap_or(Value::Bool(truthy)))
    }

    fn if_error(args: &[Value]) -> Result<Value, Failure> {
        Ok(match args.first() {
            Some(Value::Error(_)) => args.get(1).cloned().unwrap_or(Value::Undefined),
            Some(other) => other.clone(),
            None => Value::Undefined,
        })
    }

    fn array_answer(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Array(vec![Value::Number(1.0)]))
    }

    fn undefined_answer(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Undefined)
    }

    fn calc_answer(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Error(ErrorValue::Calc))
    }

    fn infinity_answer(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Number(f64::INFINITY))
    }

    fn date_answer(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Date(mixdog_js::time::local_to_utc_ms(2024, 1, 31, 0, 0, 0, 0)))
    }

    fn thrower(_: &[Value]) -> Result<Value, Failure> {
        Err(Failure::thrown("boom"))
    }

    const TABLE: Table = &[
        ("SUM", sum),
        ("IF", if_function),
        ("IFERROR", if_error),
        ("COUNTIF", sum),
        ("TEXT", sum),
        ("ARRAY", array_answer),
        ("NOTHING", undefined_answer),
        ("CALC", calc_answer),
        ("INFINITY", infinity_answer),
        ("DATE", date_answer),
        ("THROW", thrower),
    ];

    fn run(formula: &str) -> Result<Value, Failure> {
        run_in(&mut Cells::new(), formula)
    }

    fn run_in(cells: &mut Cells, formula: &str) -> Result<Value, Failure> {
        evaluate_formula_with(&Registry::new(&[TABLE]), formula, cells)
    }

    fn number(formula: &str) -> f64 {
        match run(formula) {
            Ok(Value::Number(number)) => number,
            other => panic!("{formula}: {other:?}"),
        }
    }

    fn error(formula: &str) -> ErrorValue {
        match run(formula) {
            Ok(Value::Error(error)) => error,
            other => panic!("{formula}: {other:?}"),
        }
    }

    fn truth(formula: &str) -> bool {
        match run(formula) {
            Ok(Value::Bool(flag)) => flag,
            other => panic!("{formula}: {other:?}"),
        }
    }

    fn refusal(formula: &str) -> String {
        match run(formula) {
            Err(Failure::Unsupported(refusal)) => refusal.reason,
            other => panic!("{formula}: {other:?}"),
        }
    }

    fn text_of(formula: &str) -> String {
        match run(formula) {
            Ok(Value::Text(text)) => text,
            other => panic!("{formula}: {other:?}"),
        }
    }

    #[test]
    fn precedence_coercion_and_error_propagation() {
        assert_eq!(number("=2+3*4"), 14.0);
        assert_eq!(number("=(1+2)*3"), 9.0);
        // Excel binds unary minus tighter than the power operator, so this is 4.
        assert_eq!(number("=-2^2"), 4.0);
        assert_eq!(number("=2^3^2"), 64.0);
        assert_eq!(number("=10%"), 0.1);
        assert_eq!(number("=A1+A2"), 5.0);
        assert_eq!(number("=ZZ9+1"), 1.0);
        assert_eq!(number("=\"3\"+4"), 7.0);
        assert_eq!(number("=TRUE+1"), 2.0);
        assert_eq!(text_of("=\"a\"&\"b\""), "ab");
        assert_eq!(text_of("=1&2"), "12");
        assert_eq!(text_of("=0.1+0.2&\"\""), "0.30000000000000004");
        assert!(truth("=A1>1") && truth("=B1=\"NORTH\"") && truth("=\"a\"<\"B\"") && truth("=2<\"a\""));
        assert_eq!(error("=A1/0"), ErrorValue::Div0);
        assert_eq!(error("=A1/0+1"), ErrorValue::Div0);
        assert_eq!(error("=\"x\"+1"), ErrorValue::Value);
        assert_eq!(error("=(-8)^(1/3)"), ErrorValue::Num);
        assert_eq!(error("=10^400"), ErrorValue::Num);
        assert_eq!(error("=D1+1"), ErrorValue::Na);
        // A text that reads as an error is that error, also when a formula builds it.
        assert_eq!(error("=\"#N\"&\"/A\""), ErrorValue::Na);
    }

    #[test]
    fn a_range_where_one_value_is_expected_is_refused() {
        assert_eq!(refusal("=A1:A2+1"), "a range used where one value is expected");
        assert_eq!(refusal("=A1:A2"), "a function that answers with an array");
        assert_eq!(refusal("=ARRAY()"), "a function that answers with an array");
    }

    #[test]
    fn functions_read_ranges_and_error_tolerant_ones_keep_the_error() {
        assert_eq!(number("=SUM(A1:A2)"), 5.0);
        assert_eq!(number("=sum(A1:A2,10)"), 15.0);
        assert_eq!(number("=_xlfn.SUM(1,2)"), 3.0);
        assert_eq!(number("=IF(A1>1,10,20)"), 10.0);
        assert_eq!(text_of("=IFERROR(1/0,\"safe\")"), "safe");
        // The error of an argument is the answer of a function that does not tolerate it.
        assert_eq!(error("=SUM(1/0,2)"), ErrorValue::Div0);
        assert_eq!(error("=SUM(1,#N/A)"), ErrorValue::Na);
        assert_eq!(text_of("=NOTHING()"), "");
        assert_eq!(error("=CALC()"), ErrorValue::Value);
        assert_eq!(error("=INFINITY()"), ErrorValue::Num);
        assert_eq!(error("=1e999"), ErrorValue::Num);
        assert_eq!(run("=THROW()"), Err(Failure::thrown("boom")));
    }

    #[test]
    fn dates_answer_as_serials_in_the_local_zone() {
        let seoul: mixdog_js::time::Tz = "Asia/Seoul".parse().expect("zone");
        let los_angeles: mixdog_js::time::Tz = "America/Los_Angeles".parse().expect("zone");
        for zone in [seoul, los_angeles] {
            mixdog_js::time::with_local_zone(zone, || assert_eq!(number("=DATE()"), 45322.0));
        }
    }

    #[test]
    fn refusals_carry_the_node_texts() {
        assert_eq!(refusal("=NOTAFUNCTION(1)"), "NOTAFUNCTION is not implemented");
        assert_eq!(refusal("=TaxRate*2"), "defined name TaxRate");
        assert_eq!(refusal("=[Book1]Sheet1!A1"), "a workbook or table reference");
        assert_eq!(refusal("=SUM(A1:A2"), "the call is never closed");
        assert_eq!(refusal("="), "the formula is empty");
        assert_eq!(refusal("=  "), "the formula is empty");
        assert_eq!(refusal("=SUM(A:A)"), "a whole-column reference without a known used range");
        assert_eq!(refusal("=SUM(1:2)"), "a whole-row reference without a known used range");
        let wildcard = "COUNTIF with a wildcard criterion, which this engine does not match";
        assert_eq!(refusal("=COUNTIF(A1:A2,\"n*\")"), wildcard);
        assert_eq!(refusal("=COUNTIF(A1:A2,\"nor?h\")"), wildcard);
        assert_eq!(refusal("=COUNTIF(A1:A2,#NAME?)"), wildcard);
        assert_eq!(number("=COUNTIF(A1:A2,\"n~*\")"), 5.0);
        assert_eq!(refusal("=ROW(A1)"), "ROW, which answers about a cell this engine reads as a value");
        assert_eq!(refusal("=FORMULATEXT(A1)"), "FORMULATEXT, which answers about a cell this engine reads as a value");
        assert_eq!(refusal("=ISBLANK(A9)"), "ISBLANK, which cannot tell an empty cell from empty text here");
        let date_format = "TEXT with a date format, which this engine cannot render";
        assert_eq!(refusal("=TEXT(A1,\"yyyy-mm-dd\")"), date_format);
        // A format of digits and of quoted or escaped letters is no date format; a missing one reads as `undefined`.
        assert_eq!(number("=TEXT(1,\"0.00\")"), 1.0);
        assert_eq!(number("=TEXT(1,\"0 \"\"days\"\"\")"), 1.0);
        assert_eq!(number("=TEXT(1,\"0\\d\")"), 1.0);
        assert_eq!(refusal("=TEXT(1)"), date_format);
    }

    #[test]
    fn whole_columns_and_rows_are_bounded_by_the_used_extent() {
        let mut cells = Cells::new();
        cells.extent = Some(Extent { rows: 2, columns: 3 });
        assert_eq!(run_in(&mut cells, "=SUM(A:A)"), Ok(Value::Number(5.0)));
        assert_eq!(cells.asked, ["Sheet1!A1", "Sheet1!A2"]);
        cells.asked.clear();
        assert_eq!(run_in(&mut cells, "=SUM(1:1)"), Ok(Value::Number(2.0)));
        assert_eq!(cells.asked, ["Sheet1!A1", "Sheet1!B1", "Sheet1!C1"]);
    }

    #[test]
    fn references_name_their_sheet_quoted_or_bare() {
        assert_eq!(number("='Raw Data'!B2*2"), 42.0);
        assert_eq!(text_of("='raw data'!B2"), "");
        let mut cells = Cells::new();
        run_in(&mut cells, "=SUM('It''s'!$b$2:C3)").expect("sum");
        assert_eq!(cells.asked, ["It's!B2", "It's!C2", "It's!B3", "It's!C3"]);
    }

    #[test]
    fn a_range_is_read_in_row_order_and_bounded() {
        let mut cells = Cells::new();
        run_in(&mut cells, "=SUM(B2:A1)").expect("sum");
        assert_eq!(cells.asked, ["Sheet1!A1", "Sheet1!B1", "Sheet1!A2", "Sheet1!B2"]);
        assert_eq!(refusal("=SUM(A1:ZZZ9999999)"), "the range is larger than this engine evaluates");
        assert_eq!(run("=SUM(A0:B1)"), Err(Failure::thrown("Invalid cell reference: A0")));
        assert_eq!(text_of("=A0"), "");
    }

    #[test]
    fn defined_names_read_as_what_they_stand_for() {
        let mut cells = Cells::new();
        cells.names.insert("TaxRate".to_owned(), "'Raw Data'!$B$2".to_owned());
        cells.names.insert("Uplift".to_owned(), "=1.5".to_owned());
        cells.names.insert("Empty".to_owned(), String::new());
        cells.names.insert("Loop".to_owned(), "Loop+1".to_owned());
        assert_eq!(run_in(&mut cells, "=TaxRate*21"), Ok(Value::Number(441.0)));
        assert_eq!(run_in(&mut cells, "=Uplift*4"), Ok(Value::Number(6.0)));
        assert!(matches!(run_in(&mut cells, "=Empty+1"), Err(Failure::Unsupported(refusal)) if refusal.reason == "defined name Empty"));
        // A name that defines itself ends in a refusal, not a stack overflow.
        assert!(matches!(run_in(&mut cells, "=Loop"), Err(Failure::Unsupported(_))));
    }

    #[test]
    fn a_very_long_formula_does_not_exhaust_the_stack() {
        let long = format!("={}", vec!["1"; 20_000].join("+"));
        assert_eq!(number(&long), 20_000.0);
        let signs = format!("={}1", "-".repeat(20_001));
        assert_eq!(number(&signs), -1.0);
    }
}
