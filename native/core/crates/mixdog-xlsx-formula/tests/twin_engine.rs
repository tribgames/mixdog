//! Twin test `engine`: the recording of Node's formula engine (`native/core/fixtures/office-engine/golden.json`, written
//! by `benchmarks/rust-core/recorders/record-office-engine.mjs`) against this crate. Node ran a corpus of formulas
//! (operators, coercions, errors, references, ranges, sheet names, defined names, refusals) against a stub workbook with
//! the library limited to a fixed handful; this test registers the same handful and every value (f64 bits), error value,
//! refusal text, exception message and cell request, in order, must be equal. Also `formulaReferences`,
//! `translateSharedFormula`, `isBlank` and `isFormulaError`, and the cases of the Node unit test that need no library
//! function beyond the handful. Re-recording is `twin_live_engine` (ignored: it runs Node).

use std::collections::HashMap;

use mixdog_js::time::{Tz, local_fields, local_to_utc_ms, with_local_zone};
use mixdog_office_base::twin;
use mixdog_xlsx_formula::coerce::{any_error, any_is_error, flatten, is_truthy, parse_float, parse_number, to_js_string};
use mixdog_xlsx_formula::{
    Context, ErrorValue, Extent, Failure, Registry, Table, Value, evaluate_formula_with, formula_references, is_blank,
    is_formula_error, translate_shared_formula,
};
use serde_json::{Value as Json, json};

fn arg(args: &[Value], at: usize) -> Value {
    args.get(at).cloned().unwrap_or(Value::Undefined)
}

/// `SUM` of formulajs.
fn sum_values(args: &[Value]) -> Value {
    let mut result = Value::Number(0.0);
    for value in args {
        if matches!(result, Value::Error(_)) {
            break;
        }
        let add = match value {
            Value::Error(error) => {
                result = Value::Error(*error);
                continue;
            }
            Value::Number(number) => *number,
            Value::Text(text) => {
                let parsed = parse_float(text);
                if parsed.is_nan() {
                    continue;
                }
                parsed
            }
            Value::Array(items) => match sum_values(items) {
                Value::Number(inner) => inner,
                other => {
                    result = other;
                    continue;
                }
            },
            _ => continue,
        };
        if let Value::Number(total) = &mut result {
            *total += add;
        }
    }
    result
}

fn sum(args: &[Value]) -> Result<Value, Failure> {
    Ok(sum_values(args))
}

fn abs(args: &[Value]) -> Result<Value, Failure> {
    Ok(match parse_number(&arg(args, 0)) {
        Value::Number(number) => Value::Number(number.abs()),
        other => other,
    })
}

fn if_function(args: &[Value]) -> Result<Value, Failure> {
    let test = arg(args, 0);
    if matches!(test, Value::Error(_)) {
        return Ok(test);
    }
    let blank_is_zero = |value: Value| if matches!(value, Value::Undefined | Value::Null) { Value::Number(0.0) } else { value };
    let if_true = blank_is_zero(if args.len() >= 2 { arg(args, 1) } else { Value::Bool(true) });
    let if_false = blank_is_zero(if args.len() == 3 { arg(args, 2) } else { Value::Bool(false) });
    Ok(if is_truthy(&test) { if_true } else { if_false })
}

/// `ISERR` of formulajs: the errors it lists (not `#N/A`, `#GETTING_DATA`), and a number that is not finite.
fn is_err(value: &Value) -> bool {
    match value {
        Value::Error(error) => {
            matches!(error, ErrorValue::Value | ErrorValue::Ref | ErrorValue::Div0 | ErrorValue::Num | ErrorValue::Name | ErrorValue::Nil)
        }
        Value::Number(number) => !number.is_finite(),
        _ => false,
    }
}

fn is_error(value: &Value) -> bool {
    is_err(value) || matches!(value, Value::Error(ErrorValue::Na))
}

fn iserror(args: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(is_error(&arg(args, 0))))
}

fn iferror(args: &[Value]) -> Result<Value, Failure> {
    let value = arg(args, 0);
    Ok(if is_error(&value) { arg(args, 1) } else { value })
}

fn error_type(args: &[Value]) -> Result<Value, Failure> {
    Ok(match arg(args, 0) {
        Value::Error(ErrorValue::Nil) => Value::Number(1.0),
        Value::Error(ErrorValue::Div0) => Value::Number(2.0),
        Value::Error(ErrorValue::Value) => Value::Number(3.0),
        Value::Error(ErrorValue::Ref) => Value::Number(4.0),
        Value::Error(ErrorValue::Name) => Value::Number(5.0),
        Value::Error(ErrorValue::Num) => Value::Number(6.0),
        Value::Error(ErrorValue::Na) => Value::Number(7.0),
        Value::Error(ErrorValue::Data) => Value::Number(8.0),
        _ => Value::Error(ErrorValue::Na),
    })
}

fn na(_: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Error(ErrorValue::Na))
}

fn concatenate(args: &[Value]) -> Result<Value, Failure> {
    let flat = flatten(args);
    if let Some(error) = any_error(&flat) {
        return Ok(Value::Error(error));
    }
    let joined: Vec<String> = flat
        .iter()
        .map(|value| match value {
            Value::Bool(true) => "TRUE".to_owned(),
            Value::Bool(false) => "FALSE".to_owned(),
            Value::Undefined | Value::Null => String::new(),
            other => to_js_string(other),
        })
        .collect();
    Ok(Value::Text(joined.concat()))
}

/// `new Date(year, month, day)` in the local zone, month counted from 0: fields are truncated, a year of 0 to 99 is
/// 1900 plus it, and a field that overflows carries.
fn new_date(year: f64, month: f64, day: f64) -> f64 {
    if !(year.is_finite() && month.is_finite() && day.is_finite()) {
        return f64::NAN;
    }
    let (year, month, day) = (year.trunc(), month.trunc(), day.trunc());
    if year.abs() > 400_000.0 || month.abs() > 1e7 || day.abs() > 1e9 {
        return f64::NAN;
    }
    let year = if (0.0..=99.0).contains(&year) { year + 1900.0 } else { year };
    let (year, month, day) = (year as i64, month as i64, day as i64);
    local_to_utc_ms(year + month.div_euclid(12), month.rem_euclid(12) + 1, day, 0, 0, 0, 0)
}

fn date(args: &[Value]) -> Result<Value, Failure> {
    let (year, month, day) = (parse_number(&arg(args, 0)), parse_number(&arg(args, 1)), parse_number(&arg(args, 2)));
    if any_is_error(&[year.clone(), month.clone(), day.clone()]) {
        return Ok(Value::Error(ErrorValue::Value));
    }
    let (Value::Number(year), Value::Number(month), Value::Number(day)) = (year, month, day) else {
        return Ok(Value::Error(ErrorValue::Value));
    };
    let time = new_date(year, month - 1.0, day);
    if local_fields(time).is_some_and(|fields| fields.year < 0) {
        return Ok(Value::Error(ErrorValue::Num));
    }
    Ok(Value::Date(time))
}

fn datevalue(args: &[Value]) -> Result<Value, Failure> {
    let Value::Text(text) = arg(args, 0) else { return Ok(Value::Error(ErrorValue::Value)) };
    let time = mixdog_js::time::date_parse(&text);
    Ok(if time.is_nan() { Value::Error(ErrorValue::Value) } else { Value::Date(time) })
}

/// What the recording's library throws for the functions the engine refuses before it calls them.
fn not_recorded(_: &[Value]) -> Result<Value, Failure> {
    Err(Failure::thrown("this function is not part of the recorded library"))
}

const HANDFUL: Table = &[
    ("SUM", sum),
    ("ABS", abs),
    ("IF", if_function),
    ("IFERROR", iferror),
    ("ISERROR", iserror),
    ("ERROR.TYPE", error_type),
    ("NA", na),
    ("CONCATENATE", concatenate),
    ("DATE", date),
    ("DATEVALUE", datevalue),
    ("COUNTIF", not_recorded),
    ("SUMIF", not_recorded),
    ("TEXT", not_recorded),
];

fn registry() -> Registry {
    Registry::new(&[HANDFUL])
}

fn from_json(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Bool(*flag),
        Json::Number(number) => Value::Number(number.as_f64().expect("finite")),
        Json::String(text) => Value::Text(text.clone()),
        other => panic!("not a cell value: {other}"),
    }
}

/// The stub workbook of the recording.
struct Stub<'a> {
    workbook: &'a Json,
    sheet: String,
    trace: Vec<String>,
}

impl Context for Stub<'_> {
    fn sheet(&self) -> &str {
        &self.sheet
    }

    fn value(&mut self, sheet: &str, reference: &str) -> Result<Value, Failure> {
        self.trace.push(format!("{sheet}!{reference}"));
        if sheet == self.workbook["missingSheet"].as_str().unwrap_or_default() {
            return Err(Failure::unsupported(format!("sheet \"{sheet}\" is not in this workbook")));
        }
        if sheet == self.workbook["throwingSheet"].as_str().unwrap_or_default() {
            return Err(Failure::thrown("boom"));
        }
        Ok(self.workbook["sheets"][sheet].get(reference).map_or_else(|| Value::text(""), from_json))
    }

    fn extent(&mut self, sheet: &str) -> Option<Extent> {
        let extent = self.workbook["extents"].get(sheet)?;
        Some(Extent { rows: extent["rows"].as_u64()?, columns: extent["columns"].as_u64()? })
    }

    fn defined_name(&mut self, name: &str) -> Option<String> {
        self.workbook["names"].get(name.to_uppercase())?.as_str().map(str::to_owned)
    }
}

fn encode(value: &Value) -> Json {
    match value {
        Value::Null => json!({ "t": "null" }),
        Value::Undefined => json!({ "t": "undefined" }),
        Value::Number(number) => json!({ "t": "number", "bits": format!("{:016x}", number.to_bits()) }),
        Value::Text(text) => json!({ "t": "text", "v": text }),
        Value::Utf16(units) => json!({"t":"utf16","units":units}),
        Value::Error(error) => json!({ "t": "error", "v": error.message() }),
        Value::Bool(flag) => json!({ "t": "bool", "v": flag }),
        other => panic!("not an engine result: {other:?}"),
    }
}

fn outcome(result: Result<Value, Failure>) -> Json {
    match result {
        Ok(value) => json!({ "value": encode(&value) }),
        Err(Failure::Unsupported(refusal)) => json!({ "unsupported": refusal.reason }),
        Err(Failure::Thrown(message)) => json!({ "threw": message }),
    }
}

fn zone(name: &str) -> Tz {
    name.parse().unwrap_or_else(|_| panic!("time zone {name}"))
}

fn golden() -> Json {
    twin::load_golden("office-engine")
}

fn report(what: &str, wrong: &[String]) {
    assert!(wrong.is_empty(), "{what}: {} differ from the recording, the first:\n{}", wrong.len(), wrong.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
}

fn every_case_equals_the_recording() {
    let golden = golden();
    let registry = registry();
    let mut wrong = Vec::new();
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 900, "the corpus is {} cases", cases.len());
    for case in cases {
        let formula = case["formula"].as_str().expect("formula");
        let sheet = case["sheet"].as_str().unwrap_or("Sheet1").to_owned();
        let mut stub = Stub { workbook: &golden["workbook"], sheet: sheet.clone(), trace: Vec::new() };
        let result = with_local_zone(zone(case["zone"].as_str().expect("zone")), || evaluate_formula_with(&registry, formula, &mut stub));
        let mut produced = outcome(result);
        let produced_map = produced.as_object_mut().expect("outcome");
        produced_map.insert("traceCount".to_owned(), json!(stub.trace.len()));
        produced_map.insert("trace".to_owned(), json!(stub.trace.iter().take(64).collect::<Vec<_>>()));
        for key in ["value", "unsupported", "threw", "traceCount", "trace"] {
            if case.get(key) != produced.get(key) {
                wrong.push(format!("{formula} on {sheet} ({}): {key} recorded {} produced {}", case["zone"], case.get(key).unwrap_or(&Json::Null), produced.get(key).unwrap_or(&Json::Null)));
            }
        }
    }
    report("formulas", &wrong);
}

fn every_reference_list_equals_the_recording() {
    let golden = golden();
    let mut wrong = Vec::new();
    for case in golden["references"].as_array().expect("references") {
        let formula = case["formula"].as_str().expect("formula");
        let produced = match formula_references(formula) {
            Ok(found) => json!({ "references": found.iter().map(|item| json!([item.text, item.utf16_start])).collect::<Vec<_>>() }),
            Err(refusal) => json!({ "unsupported": refusal.reason }),
        };
        let recorded = match case.get("references") {
            Some(list) => json!({ "references": list.as_array().expect("list").iter().map(|item| json!([item["text"], item["start"]])).collect::<Vec<_>>() }),
            None => json!({ "unsupported": case["unsupported"] }),
        };
        if recorded != produced {
            wrong.push(format!("{formula}: recorded {recorded} produced {produced}"));
        }
    }
    report("references", &wrong);
}

fn every_translation_equals_the_recording() {
    let golden = golden();
    let mut wrong = Vec::new();
    let translations = golden["translations"].as_array().expect("translations");
    assert!(translations.len() > 300);
    for case in translations {
        let formula = case["formula"].as_str().expect("formula");
        let (rows, columns) = (case["rowDelta"].as_i64().expect("rows"), case["columnDelta"].as_i64().expect("columns"));
        let produced = match translate_shared_formula(formula, rows, columns) {
            Ok(text) => json!({ "value": text }),
            Err(refusal) => json!({ "unsupported": refusal.reason }),
        };
        for key in ["value", "unsupported"] {
            if case.get(key) != produced.get(key) {
                wrong.push(format!("{formula} by ({rows}, {columns}): {key} recorded {} produced {}", case.get(key).unwrap_or(&Json::Null), produced.get(key).unwrap_or(&Json::Null)));
            }
        }
    }
    report("translations", &wrong);
}

fn every_predicate_equals_the_recording() {
    let golden = golden();
    let mut wrong = Vec::new();
    for case in golden["predicates"].as_array().expect("predicates") {
        let input = &case["input"];
        let value = match input["t"].as_str().expect("type") {
            "null" => Value::Null,
            "undefined" => Value::Undefined,
            "number" => Value::Number(input["v"].as_f64().expect("number")),
            "bool" => Value::Bool(input["v"].as_bool().expect("bool")),
            _ => Value::Text(input["v"].as_str().expect("text").to_owned()),
        };
        if case["isBlank"] != json!(is_blank(&value)) || case["isFormulaError"] != json!(is_formula_error(&value)) {
            wrong.push(format!("{input}: recorded {case}"));
        }
    }
    report("predicates", &wrong);
}

#[test]
fn every_output_equals_the_recording() {
    every_case_equals_the_recording();
    every_reference_list_equals_the_recording();
    every_translation_equals_the_recording();
    every_predicate_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-xlsx-formula --test twin_engine -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable/xlsx-formula-engine.mjs)"]
fn twin_live_engine() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-engine.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}

// ---------------------------------------------------------------------------------------------------------------
// The cases of `xlsx-formula-engine.test.mjs` that need no library function beyond the handful

struct Cells(HashMap<&'static str, Value>);

impl Context for Cells {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, sheet: &str, reference: &str) -> Result<Value, Failure> {
        if !sheet.eq_ignore_ascii_case("sheet1") {
            return Ok(Value::text(""));
        }
        Ok(self.0.get(reference).cloned().unwrap_or_else(|| Value::text("")))
    }
}

fn evaluate(formula: &str) -> Result<Value, Failure> {
    let mut cells = Cells(HashMap::from([
        ("A1", Value::Number(2.0)),
        ("A2", Value::Number(3.0)),
        ("B1", Value::text("north")),
        ("C1", Value::Bool(true)),
    ]));
    with_local_zone(zone("Asia/Seoul"), || evaluate_formula_with(&registry(), formula, &mut cells))
}

fn number(formula: &str) -> f64 {
    match evaluate(formula) {
        Ok(Value::Number(number)) => number,
        other => panic!("{formula}: {other:?}"),
    }
}

fn text(formula: &str) -> String {
    match evaluate(formula) {
        Ok(Value::Text(text)) => text,
        other => panic!("{formula}: {other:?}"),
    }
}

fn refused(formula: &str) {
    assert!(matches!(evaluate(formula), Err(Failure::Unsupported(_))), "{formula}: {:?}", evaluate(formula));
}

#[test]
fn the_engine_follows_excel_precedence_coercion_and_error_propagation() {
    assert_eq!(number("=2+3*4"), 14.0);
    assert_eq!(number("=(1+2)*3"), 9.0);
    // Excel binds unary minus tighter than the power operator, so this is 4.
    assert_eq!(number("=-2^2"), 4.0);
    assert_eq!(number("=10%"), 0.1);
    assert_eq!(text("=\"a\"&\"b\""), "ab");
    assert_eq!(text("=1&2"), "12");
    assert_eq!(number("=A1+A2"), 5.0);
    assert_eq!(evaluate("=A1>1"), Ok(Value::Bool(true)));
    assert_eq!(evaluate("=B1=\"NORTH\""), Ok(Value::Bool(true)));
    assert_eq!(evaluate("=A1/0"), Ok(Value::Error(ErrorValue::Div0)));
    assert_eq!(evaluate("=A1/0+1"), Ok(Value::Error(ErrorValue::Div0)));
    assert_eq!(number("=ZZ9+1"), 1.0);
}

#[test]
fn the_engine_reads_ranges_calls_functions_and_keeps_if_from_inheriting_an_error() {
    assert_eq!(number("=SUM(A1:A2)"), 5.0);
    assert_eq!(text("=IF(A1>1,\"big\",\"small\")"), "big");
    // The false branch divides by zero; Excel never evaluates it, and the answer must not inherit an error from a branch
    // the test did not take.
    assert_eq!(number("=IF(A1=0,0,10/A1)"), 5.0);
    assert_eq!(text("=IFERROR(1/0,\"safe\")"), "safe");
    // ERROR.TYPE reports on the error it is given instead of inheriting it.
    assert_eq!(number("=ERROR.TYPE(1/0)"), 2.0);
    assert_eq!(text("=CONCATENATE(B1,\"-\",A1)"), "north-2");
    // A date is a serial counting calendar days: 31 January 2024 is day 45322, and reading the library's local-midnight
    // date as a UTC instant made it the day before east of Greenwich.
    assert_eq!(number("=DATE(2024,1,31)"), 45322.0);
    // The same day read out of text, which the library dates differently again.
    assert_eq!(number("=DATEVALUE(\"2024-01-31\")"), 45322.0);
}

#[test]
fn the_engine_refuses_what_it_cannot_stand_behind_instead_of_guessing() {
    for formula in [
        "=NOTAFUNCTION(1)",
        "=TaxRate*2",
        "=[Book1]Sheet1!A1",
        "=SUM(A1:A2",
        "=A1:A2+1",
        // Nothing here can say how far column A reaches, and a million empty rows is not an answer; only a workbook that
        // knows its used range gets one.
        "=SUM(A:A)",
        // Excel matches a wildcard criterion against the range; the library counts nothing and calls it an answer, and ROW
        // describes a cell this engine only ever sees the value of.
        "=COUNTIF(A1:A2,\"n*\")",
        "=SUMIF(B1:B1,\"nor?h\",A1:A1)",
        "=ROW(A1)",
        // An empty cell and empty text look the same to this engine, and a date format has no faithful rendering here.
        "=ISBLANK(A9)",
        "=TEXT(A1,\"yyyy-mm-dd\")",
    ] {
        refused(formula);
    }
}


/// Owned by formula-core; enable after the four library modules have been wired
/// into TABLES. These are the remaining engine-level assertions from the original
/// xlsx-formula-engine.test.mjs, not substitutes implemented by the test handful.
#[test]
#[ignore = "integration gate: requires the four formula library tasks registered in TABLES"]
fn original_engine_cases_with_the_production_library() {
    use mixdog_xlsx_formula::evaluate_formula;
    let mut cells = Cells(HashMap::from([
        ("A1", Value::Number(2.0)), ("A2", Value::Number(3.0)),
        ("B1", Value::text("north")), ("C1", Value::Bool(true)),
    ]));
    let cases = [
        ("=ROUND(AVERAGE(A1:A2),1)", Value::Number(2.5)),
        ("=_xlfn.TEXTJOIN(\"-\",TRUE,\"a\",\"b\")", Value::text("a-b")),
        ("=YEAR(DATE(2024,5,6))", Value::Number(2024.0)),
        ("=DAY(DATE(2024,5,6))", Value::Number(6.0)),
        ("=ROUND(STDEV(A1:A2),4)", Value::Number(0.7071)),
        ("=RANK(A1,A1:A2)", Value::Number(2.0)),
        ("=_xlfn.RANK.EQ(A1,A1:A2)", Value::Number(2.0)),
        ("=COUNTIF(A1:A2,\">2\")", Value::Number(1.0)),
        ("=TEXT(1234.5,\"0.00\")", Value::text("1234.50")),
    ];
    with_local_zone(zone("Asia/Seoul"), || {
        for (formula, expected) in cases {
            assert_eq!(evaluate_formula(formula, &mut cells), Ok(expected), "{formula}");
        }
    });
}
