//! The argument conventions every formula function shares: the `utils/common.js` of `@formulajs/formulajs` 4.6.1
//! (`flatten`, `parseNumber`, `parseBool`, `parseDate`, `parseString`, `anyIsError`, `argsToArray`, the 1900 date
//! serial rules, the criteria evaluator of `COUNTIF` and its family) and the JavaScript conversions those rely on
//! (`String(x)`, `Number(x)`, `parseFloat`, `==`, `<`), so the library modules read arguments one way.
//!
//! Dates are time values in milliseconds read in the local zone (`mixdog_js::time`): `serial_to_date` builds the date
//! at local midnight as the library does.

use std::cmp::Ordering;

#[cfg(test)]
use mixdog_js::time::local_fields;
use mixdog_js::time::{local_to_utc_ms, utc_to_ms};
use mixdog_js::{js_trim_start, math, number_to_string, string_to_number};

use crate::value::{ErrorValue, Failure, Value};

const DAY_MS: f64 = 86_400_000.0;
/// The largest magnitude of a valid JavaScript time value.
const MAX_TIME_MS: f64 = 8.64e15;

// ---------------------------------------------------------------------------------------------------------------
// JavaScript conversions

/// `Date.prototype.toString` through the pinned ICU display-name implementation.
fn date_to_string(time: f64) -> String {
    mixdog_js::date_to_string(time)
}

/// Lossless JavaScript String(value), including array joins and isolated surrogates.
pub fn to_js_utf16(value: &Value) -> Vec<u16> {
    match value {
        Value::Utf16(units) => units.clone(),
        Value::Text(text) => text.encode_utf16().collect(),
        Value::Array(items) => {
            let mut units = Vec::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(item, Value::Undefined | Value::Null) {
                    units.extend(to_js_utf16(item));
                }
            }
            units
        }
        other => {
            let text = match other {
                Value::Undefined => "undefined".to_owned(),
                Value::Null => "null".to_owned(),
                Value::Number(n) => number_to_string(*n),
                Value::Bool(b) => b.to_string(),
                Value::Error(e) => format!("Error: {}", e.message()),
                Value::Date(t) => date_to_string(*t),
                _ => unreachable!(),
            };
            text.encode_utf16().collect()
        }
    }
}

/// UTF-8-only adapter for consumers whose input has already been checked. Raw
/// formula strings must use to_js_utf16; this deliberately never replaces units.
pub fn to_js_string(value: &Value) -> String {
    if let Value::Text(text) = value {
        return text.clone();
    }
    String::from_utf16(&to_js_utf16(value)).expect("raw UTF-16 requires a code-unit operation")
}

pub fn utf16_number(units: &[u16]) -> f64 {
    String::from_utf16(units).map_or(f64::NAN, |text| string_to_number(&text))
}

/// parseFloat stops at the first unpaired surrogate, just as at any other junk.
pub fn parse_float_utf16(units: &[u16]) -> f64 {
    let prefix: String = char::decode_utf16(units.iter().copied()).map_while(Result::ok).collect();
    parse_float(&prefix)
}

pub fn parse_int_utf16(units: &[u16], radix: f64) -> f64 {
    let prefix: String = char::decode_utf16(units.iter().copied()).map_while(Result::ok).collect();
    mixdog_js::parse_int_radix(&prefix, radix)
}

/// Case conversion preserves isolated surrogates and maps valid scalar runs.
pub fn case_utf16(units: &[u16], upper: bool) -> Vec<u16> {
    let mut out = Vec::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<u16>| {
        let mapped = if upper { run.to_uppercase() } else { run.to_lowercase() };
        out.extend(mapped.encode_utf16());
        run.clear();
    };
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok(c) => run.push(c),
            Err(e) => {
                flush(&mut run, &mut out);
                out.push(e.unpaired_surrogate());
            }
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `Number(value)`.
pub fn to_js_number(value: &Value) -> f64 {
    match value {
        Value::Undefined => f64::NAN,
        Value::Null => 0.0,
        Value::Number(number) => *number,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Date(time) => *time,
        Value::Text(text) => string_to_number(text),
        Value::Utf16(_) | Value::Error(_) | Value::Array(_) => utf16_number(&to_js_utf16(value)),
    }
}

/// `isNaN(value)`.
pub fn is_nan_of(value: &Value) -> bool {
    to_js_number(value).is_nan()
}

/// `Boolean(value)`.
pub fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Undefined | Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => *number != 0.0 && !number.is_nan(),
        Value::Text(text) => !text.is_empty(),
        Value::Utf16(units) => !units.is_empty(),
        Value::Error(_) | Value::Date(_) | Value::Array(_) => true,
    }
}

/// `parseFloat(text)`: the longest decimal literal at the start of the text, `NaN` when there is none.
pub fn parse_float(text: &str) -> f64 {
    let text = js_trim_start(text);
    let bytes = text.as_bytes();
    let sign = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    if text[sign..].starts_with("Infinity") {
        return if bytes.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let mut end = sign + digits(sign);
    let integer = end - sign;
    let mut fraction = 0;
    if bytes.get(end) == Some(&b'.') {
        fraction = digits(end + 1);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    if integer == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let exponent_sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let exponent = digits(end + 1 + exponent_sign);
        if exponent > 0 {
            end += 1 + exponent_sign + exponent;
        }
    }
    string_to_number(&text[..end])
}

/// `a === b`. Two objects are never the same one here except an error, which the library keeps one object of.
pub fn js_strict_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Number(x), Value::Number(y)) => x == y,
        (x, y) if x.is_text() && y.is_text() => x.text_units() == y.text_units(),
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Error(x), Value::Error(y)) => x == y,
        _ => false,
    }
}

/// ToPrimitive with the hint `number` (relational operators) or `default` (`==`).
fn to_primitive(value: &Value, number_hint: bool) -> Value {
    match value {
        Value::Array(_) | Value::Error(_) => Value::from_utf16(to_js_utf16(value)),
        Value::Date(time) if number_hint => Value::Number(*time),
        Value::Date(_) => Value::from_utf16(to_js_utf16(value)),
        other => other.clone(),
    }
}

fn is_object(value: &Value) -> bool {
    matches!(value, Value::Array(_) | Value::Error(_) | Value::Date(_))
}

/// `a == b`.
pub fn js_loose_equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Undefined | Value::Null, Value::Undefined | Value::Null) => true,
        (Value::Undefined | Value::Null, _) | (_, Value::Undefined | Value::Null) => false,
        (Value::Number(x), Value::Number(y)) => x == y,
        (x, y) if x.is_text() && y.is_text() => x.text_units() == y.text_units(),
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), y) | (y, Value::Number(x)) if y.is_text() => *x == utf16_number(&y.text_units().unwrap()),
        (Value::Bool(flag), other) | (other, Value::Bool(flag)) => js_loose_equals(&Value::Number(f64::from(u8::from(*flag))), other),
        (x, y) if is_object(x) && is_object(y) => js_strict_equals(x, y),
        (x, y) if is_object(x) => js_loose_equals(&to_primitive(x, false), y),
        (x, y) => js_loose_equals(x, &to_primitive(y, false)),
    }
}

/// Code-unit order of two JavaScript strings.
pub fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The abstract relational comparison `a < b`: `None` is `undefined` (a `NaN` took part).
fn js_less(a: &Value, b: &Value) -> Option<bool> {
    let (x, y) = (to_primitive(a, true), to_primitive(b, true));
    if x.is_text() && y.is_text() {
        return Some(x.text_units().unwrap() < y.text_units().unwrap());
    }
    let (nx, ny) = (to_js_number(&x), to_js_number(&y));
    if nx.is_nan() || ny.is_nan() { None } else { Some(nx < ny) }
}

// ---------------------------------------------------------------------------------------------------------------
// Date serials

fn clip(time: f64) -> f64 {
    if time.is_finite() && time.abs() <= MAX_TIME_MS { time.trunc() } else { f64::NAN }
}

/// The calendar day of a count of days since 1970-01-01: year, month 0 to 11, day of the month.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month - 1, day)
}

/// `new Date(year, month, day, hour, minute, second)` in the local zone, `month` counted from 0: a year from 0 to 99
/// is 1900 plus it.
fn local_date(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> f64 {
    let year = if (0..=99).contains(&year) { year + 1900 } else { year };
    // `Date.UTC` and `local_to_utc_ms` count the month from 1 and carry an overflow of any field.
    let carried_year = year + month.div_euclid(12);
    let month_of_year = month.rem_euclid(12) + 1;
    local_to_utc_ms(carried_year, month_of_year, day, hour, minute, second, 0)
}

/// `serialToDate(serial)`: the date a spreadsheet serial stands for, at local time, with Excel's 1900 leap-day rule
/// (serial 60 is the 29th of February 1900).
pub fn serial_to_date(serial: f64) -> f64 {
    let serial = if serial < 60.0 { serial + 1.0 } else { serial };
    let utc_days = (serial - 25_569.0).floor();
    let info = clip(utc_days * 86_400.0 * 1000.0);
    let fractional_day = serial - serial.floor() + 0.000_000_1;
    let mut total_seconds = (86_400.0 * fractional_day).floor();
    let seconds = total_seconds % 60.0;
    total_seconds -= seconds;
    let hours = (total_seconds / (60.0 * 60.0)).floor();
    let minutes = (total_seconds / 60.0).floor() % 60.0;
    if info.is_nan() || !hours.is_finite() || !minutes.is_finite() || !seconds.is_finite() {
        return f64::NAN;
    }
    let (year, mut month, mut day) = civil_from_days((info / DAY_MS).floor() as i64);
    if (60.0..61.0).contains(&serial) {
        day = 29;
        month = 1;
    }
    local_date(year, month, day, hours as i64, minutes as i64, seconds as i64)
}

/// `dateToSerial(date)`: the serial of a date (its time value), counting from 1900-01-01 as Excel does.
pub fn date_to_serial(time: f64) -> f64 {
    let first_of_1900 = local_to_utc_ms(1900, 1, 1, 0, 0, 0, 0);
    let add_on = if time > -22_038_912e5 { 2.0 } else { 1.0 };
    ((time - first_of_1900) / DAY_MS).ceil() + add_on
}

/// `Date.UTC(year, month, ...)` of the wall-clock fields: for a caller that needs the local calendar fields as a UTC
/// instant. `month` counts from 1.
pub fn wall_clock_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, milli: i64) -> f64 {
    let year = if (0..=99).contains(&year) { year + 1900 } else { year };
    utc_to_ms(year, month, day, hour, minute, second, milli)
}

// ---------------------------------------------------------------------------------------------------------------
// Parsers

/// `parseNumber(value)`: a number, or the error it is. A value that is not a number reads as `#VALUE!`.
pub fn parse_number(value: &Value) -> Value {
    match value {
        Value::Error(_) => value.clone(),
        Value::Undefined | Value::Null => Value::Number(0.0),
        Value::Utf16(_) => Value::Error(ErrorValue::Value),
        Value::Text(text) => {
            if string_to_number(text).is_nan() || text.is_empty() {
                Value::Error(ErrorValue::Value)
            } else {
                Value::Number(parse_float(text))
            }
        }
        Value::Bool(flag) => Value::Number(f64::from(u8::from(*flag))),
        Value::Number(number) => {
            if number.is_nan() {
                Value::Error(ErrorValue::Value)
            } else {
                Value::Number(parse_float(&number_to_string(*number)))
            }
        }
        Value::Date(time) => {
            // `parseFloat` of the date's text, which begins with a letter.
            if time.is_nan() { Value::Error(ErrorValue::Value) } else { Value::Number(f64::NAN) }
        }
        Value::Array(_) => {
            let number = to_js_number(value);
            if number.is_nan() { Value::Error(ErrorValue::Value) } else { Value::Number(parse_float_utf16(&to_js_utf16(value))) }
        }
    }
}

/// `parseBool(value)`: a boolean, or the error it is.
pub fn parse_bool(value: &Value) -> Value {
    match value {
        Value::Bool(_) | Value::Error(_) => value.clone(),
        Value::Number(number) => Value::Bool(*number != 0.0),
        Value::Text(text) => match text.to_uppercase().as_str() {
            "TRUE" => Value::Bool(true),
            "FALSE" => Value::Bool(false),
            _ => Value::Error(ErrorValue::Value),
        },
        Value::Date(time) if !time.is_nan() => Value::Bool(true),
        _ => Value::Error(ErrorValue::Value),
    }
}

/// `/(\d{4})-(\d\d?)-(\d\d?)$/.test(text)`: the text ends with a year-month-day.
fn ends_with_iso_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits_before = |end: usize, count: usize| end >= count && bytes[end - count..end].iter().all(u8::is_ascii_digit);
    for day in [2_usize, 1] {
        if !digits_before(bytes.len(), day) {
            continue;
        }
        let dash = bytes.len() - day;
        if dash == 0 || bytes[dash - 1] != b'-' {
            continue;
        }
        for month in [2_usize, 1] {
            let month_end = dash - 1;
            if !digits_before(month_end, month) {
                continue;
            }
            let dash_before = month_end - month;
            if dash_before >= 5 && bytes[dash_before - 1] == b'-' && digits_before(dash_before - 1, 4) {
                return true;
            }
        }
    }
    false
}

/// `parseString(value)`: text, or the error it is.
pub fn parse_string(value: &Value) -> Value {
    match value {
        Value::Error(_) => value.clone(),
        Value::Undefined | Value::Null => Value::Text(String::new()),
        Value::Text(_) | Value::Utf16(_) => value.clone(),
        other => Value::from_utf16(to_js_utf16(other)),
    }
}

/// `parseNumberArray(values)`: the numbers, or the first error met reading from the end; an empty array is `#VALUE!`.
pub fn parse_number_array(values: &[Value]) -> Result<Vec<Value>, ErrorValue> {
    if values.is_empty() {
        return Err(ErrorValue::Value);
    }
    let mut parsed = values.to_vec();
    for at in (0..parsed.len()).rev() {
        if let Value::Error(error) = &parsed[at] {
            return Err(*error);
        }
        match parse_number(&parsed[at]) {
            Value::Error(error) => return Err(error),
            number => parsed[at] = number,
        }
    }
    Ok(parsed)
}

/// `arrayValuesToNumbers(values)`, in place: booleans become 1 and 0, text becomes its number (0 when it is none).
pub fn array_values_to_numbers(values: &mut [Value]) {
    for at in (0..values.len()).rev() {
        match &values[at] {
            Value::Bool(flag) => values[at] = Value::Number(f64::from(u8::from(*flag))),
            Value::Text(_) | Value::Utf16(_) => {
                values[at] = match parse_number(&values[at]) {
                    Value::Error(_) => Value::Number(0.0),
                    number => number,
                };
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Arrays, errors and numbers

/// `argsToArray(args)`.
pub fn args_to_array(args: &[Value]) -> Vec<Value> {
    args.to_vec()
}

fn flatten_into(value: &Value, out: &mut Vec<Value>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| flatten_into(item, out)),
        other => out.push(other.clone()),
    }
}

/// `flatten(...args)`: every argument, an array of any depth spliced into its elements in order.
pub fn flatten(args: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    args.iter().for_each(|arg| flatten_into(arg, &mut out));
    out
}

/// `isArrayLike(value)`.
pub fn is_array_like(value: &Value) -> bool {
    matches!(value, Value::Array(_))
}

/// `isFlat(values)`: no element is an array.
pub fn is_flat(values: &[Value]) -> bool {
    !values.iter().any(is_array_like)
}

/// `isDefined(value)`: neither `undefined` nor `null`.
pub fn is_defined(value: &Value) -> bool {
    !matches!(value, Value::Undefined | Value::Null)
}

/// `anyError(...values)`: the first error among them.
pub fn any_error(values: &[Value]) -> Option<ErrorValue> {
    values.iter().find_map(|value| if let Value::Error(error) = value { Some(*error) } else { None })
}

/// `anyIsError(...values)`.
pub fn any_is_error(values: &[Value]) -> bool {
    values.iter().any(|value| matches!(value, Value::Error(_)))
}

/// `anyIsString(...values)`.
pub fn any_is_string(values: &[Value]) -> bool {
    values.iter().any(|value| value.is_text())
}

/// `cleanFloat(number)`: rounded to fourteen decimals.
pub fn clean_float(number: f64) -> f64 {
    let power = 1e14;
    math::round(number * power) / power
}

/// `numbers(...args)`: the elements of the flattened arguments that are numbers.
pub fn numbers(args: &[Value]) -> Vec<f64> {
    flatten(args).into_iter().filter_map(|value| if let Value::Number(number) = value { Some(number) } else { None }).collect()
}

/// `getMatrixSize(array)`: `(rows, columns)`, the columns being the longest row.
pub fn get_matrix_size(array: &[Value]) -> (usize, usize) {
    let columns = array
        .iter()
        .map(|row| match row {
            Value::Array(items) => items.len(),
            Value::Text(text) => mixdog_js::utf16_len(text),
            Value::Utf16(units) => units.len(),
            _ => 0,
        })
        .max()
        .unwrap_or(0);
    (array.len(), columns)
}

/// `createMatrix(rowSize, columnSize)`: rows of `undefined`, `#N/A` when a size is missing and `#VALUE!` when one is
/// not above zero.
pub fn create_matrix(row_size: &Value, column_size: &Value) -> Result<Value, Failure> {
    if !is_defined(row_size) || !is_defined(column_size) {
        return Ok(Value::Error(ErrorValue::Na));
    }
    let (rows, columns) = (to_js_number(row_size), to_js_number(column_size));
    if rows <= 0.0 || columns <= 0.0 {
        return Ok(Value::Error(ErrorValue::Value));
    }
    // Array.from({length}) applies ToLength, then creates an ordinary Array.
    // ToLength(NaN) is zero; infinity clamps to 2^53-1, which exceeds the
    // ordinary Array length limit. The inner Array is never created for zero rows.
    let length = |size: f64| -> Result<usize, Failure> {
        let length = if size.is_nan() { 0.0 } else { size.trunc().min(9_007_199_254_740_991.0) };
        if length > f64::from(u32::MAX) {
            return Err(Failure::thrown("Invalid array length"));
        }
        Ok(length as usize)
    };
    let rows = length(rows)?;
    if rows == 0 {
        return Ok(Value::Array(Vec::new()));
    }
    let columns = length(columns)?;
    let allocation_error = |_| Failure::thrown("Invalid array length");
    let mut matrix = Vec::new();
    matrix.try_reserve_exact(rows).map_err(allocation_error)?;
    for _ in 0..rows {
        let mut row = Vec::new();
        row.try_reserve_exact(columns).map_err(allocation_error)?;
        row.resize(columns, Value::Undefined);
        matrix.push(Value::Array(row));
    }
    Ok(Value::Array(matrix))
}

/// `fillMatrix(matrix)`: a matrix with every empty or falsy cell 0 and every row as long as the longest.
pub fn fill_matrix(matrix: &Value) -> Result<Value, Failure> {
    if !is_truthy(matrix) {
        return Ok(Value::Error(ErrorValue::Value));
    }
    let Value::Array(rows) = matrix else {
        return Err(Failure::thrown("matrix.every is not a function"));
    };
    let mut matrix: Vec<Vec<Value>> = if rows.is_empty() || !rows.iter().all(is_array_like) {
        vec![rows.clone()]
    } else {
        rows.iter().map(|row| if let Value::Array(items) = row { items.clone() } else { Vec::new() }).collect()
    };
    for row in &mut matrix {
        for cell in row.iter_mut() {
            if !is_truthy(cell) {
                *cell = Value::Number(0.0);
            }
        }
    }
    let longest = matrix.iter().map(Vec::len).max().unwrap_or(0);
    Ok(Value::Array(
        matrix
            .into_iter()
            .map(|mut row| {
                row.resize(longest, Value::Number(0.0));
                Value::Array(row)
            })
            .collect(),
    ))
}

/// `transpose(matrix)`: the rows as columns; a missing matrix is `#VALUE!`.
pub fn transpose(matrix: &Value) -> Result<Value, Failure> {
    if !is_truthy(matrix) {
        return Ok(Value::Error(ErrorValue::Value));
    }
    let Value::Array(rows) = matrix else {
        return Err(Failure::thrown("matrix[0].map is not a function"));
    };
    let Some(Value::Array(first)) = rows.first() else {
        return Err(Failure::thrown("matrix[0].map is not a function"));
    };
    let cell = |row: &Value, at: usize| match row {
        Value::Array(items) => items.get(at).cloned().unwrap_or(Value::Undefined),
        _ => Value::Undefined,
    };
    Ok(Value::Array((0..first.len()).map(|at| Value::Array(rows.iter().map(|row| cell(row, at)).collect())).collect()))
}

/// `findField(database, title)`: the index of the column whose first row is `title`, else `#VALUE!`.
pub fn find_field(database: &[Value], title: &Value) -> Value {
    let head = |row: &Value| match row {
        Value::Array(items) => items.first().cloned().unwrap_or(Value::Undefined),
        _ => Value::Undefined,
    };
    database.iter().position(|row| js_strict_equals(&head(row), title)).map_or(Value::Error(ErrorValue::Value), |at| Value::Number(at as f64))
}

/// `initial(array, idx)`: the array without its last `idx` (one by default) elements; a value that is not an array is
/// returned as it is.
pub fn initial(array: &Value, idx: Option<usize>) -> Value {
    let Value::Array(items) = array else {
        return array.clone();
    };
    let idx = idx.filter(|idx| *idx != 0).unwrap_or(1);
    Value::Array(items[..items.len().saturating_sub(idx)].to_vec())
}

/// `rest(array, idx)`: the array without its first `idx` (one by default) elements.
pub fn rest(array: &Value, idx: Option<usize>) -> Value {
    let Value::Array(items) = array else {
        return array.clone();
    };
    let idx = idx.filter(|idx| *idx != 0).unwrap_or(1);
    Value::Array(items.get(idx..).unwrap_or_default().to_vec())
}

// ---------------------------------------------------------------------------------------------------------------
// Criteria: `COUNTIF(range, ">5")` and its family

#[derive(Debug, Clone)]
enum CriteriaToken {
    Operator(String),
    Literal(Value),
}

static UNDEFINED: Value = Value::Undefined;

const VALID_SYMBOLS: [&str; 6] = [">", ">=", "<", "<=", "=", "<>"];

/// `castValueToCorrectType(value)`: text of digits (with one decimal point at most) is the number.
fn cast_value(text: String) -> Value {
    let bytes = text.as_bytes();
    let integer = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    let numeric =
        integer > 0 && (integer == bytes.len() || (bytes[integer] == b'.' && bytes.len() > integer + 1 && bytes[integer + 1..].iter().all(u8::is_ascii_digit)));
    if numeric { Value::Number(parse_float(&text)) } else { Value::Text(text) }
}

/// `tokenizeExpression(expression)`: runs of the characters `>`, `<` and `=` and runs of everything else.
fn tokenize_expression(expression: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut value = String::new();
    let mut symbol = String::new();
    for c in expression.chars() {
        if matches!(c, '>' | '<' | '=') {
            symbol.push(c);
            if !value.is_empty() {
                tokens.push(std::mem::take(&mut value));
            }
        } else {
            if !symbol.is_empty() {
                tokens.push(std::mem::take(&mut symbol));
            }
            value.push(c);
        }
    }
    if !value.is_empty() {
        tokens.push(value);
    }
    if !symbol.is_empty() {
        tokens.push(symbol);
    }
    tokens
}

/// `analyzeTokens(tokens)`.
fn analyze_tokens(tokens: &[String]) -> Vec<CriteriaToken> {
    let mut literal = String::new();
    let mut analyzed = Vec::new();
    for (at, token) in tokens.iter().enumerate() {
        if at == 0 && VALID_SYMBOLS.contains(&token.as_str()) {
            analyzed.push(CriteriaToken::Operator(token.clone()));
        } else {
            literal.push_str(token);
        }
    }
    if !literal.is_empty() {
        analyzed.push(CriteriaToken::Literal(cast_value(literal)));
    }
    if matches!(analyzed.first(), Some(CriteriaToken::Literal(_))) {
        analyzed.insert(0, CriteriaToken::Operator("=".to_owned()));
    }
    analyzed
}

/// `computeExpression(tokens)` and `evaluate(values, operator)`: the first literal is compared with the second by the
/// last operator, with JavaScript's own `==` and relational rules.
fn compute_expression(tokens: &[CriteriaToken]) -> bool {
    let mut values: Vec<&Value> = Vec::new();
    let mut operator: Option<&str> = None;
    for token in tokens {
        match token {
            CriteriaToken::Operator(symbol) => operator = Some(symbol),
            CriteriaToken::Literal(value) => values.push(value),
        }
    }
    let first = values.first().copied().unwrap_or(&UNDEFINED);
    let second = values.get(1).copied().unwrap_or(&UNDEFINED);
    match operator {
        Some(">") => js_less(second, first) == Some(true),
        Some(">=") => js_less(first, second) == Some(false),
        Some("<") => js_less(first, second) == Some(true),
        Some("<=") => js_less(second, first) == Some(false),
        Some("=") => js_loose_equals(first, second),
        Some("<>") => !js_loose_equals(first, second),
        _ => false,
    }
}

/// Whether `value` meets `criteria` as `COUNTIF` reads it: `">5"`, `"<>x"`, `"=3"`, a bare value for equality.
pub fn meets_criteria(value: &Value, criteria: &Value) -> bool {
    let mut tokens = vec![CriteriaToken::Literal(value.clone())];
    let units = to_js_utf16(criteria);
    if let Ok(text) = String::from_utf16(&units) {
        tokens.extend(analyze_tokens(&tokenize_expression(&text)));
    } else {
        let end = units.iter().take_while(|u| matches!(**u, 60..=62)).count();
        let operator: String = units[..end].iter().map(|u| char::from_u32(u32::from(*u)).unwrap()).collect();
        if VALID_SYMBOLS.contains(&operator.as_str()) {
            tokens.push(CriteriaToken::Operator(operator));
            tokens.push(CriteriaToken::Literal(Value::from_utf16(units[end..].to_vec())));
        } else {
            tokens.push(CriteriaToken::Operator("=".into()));
            tokens.push(CriteriaToken::Literal(Value::from_utf16(units)));
        }
    }
    compute_expression(&tokens)
}

/// `applyCriteria(range, criteriaRange1, criteria1, ...)`: the numbers of `range` whose position meets every
/// criterion (all of them: the conditions are joined by AND), or the error the range is.
pub fn apply_criteria(args: &[Value]) -> Result<Vec<Value>, ErrorValue> {
    let mut args = args.to_vec();
    if args.is_empty() {
        return Err(ErrorValue::Value);
    }
    let first = args.remove(0);
    let range = parse_number_array(&flatten(&[first]))?;
    let mut criterias = args;
    let pairs = criterias.len().div_ceil(2);
    for pair in 0..pairs {
        criterias[pair * 2] = Value::Array(flatten(&[criterias[pair * 2].clone()]));
    }
    let mut values = Vec::new();
    for (at, number) in range.iter().enumerate() {
        let mut met = false;
        for pair in 0..pairs {
            let Value::Array(tested) = &criterias[pair * 2] else {
                continue;
            };
            let value_to_test = tested.get(at).cloned().unwrap_or(Value::Undefined);
            let criteria = criterias.get(pair * 2 + 1).cloned().unwrap_or(Value::Undefined);
            let wildcard = matches!(criteria, Value::Undefined) || matches!(&criteria, Value::Text(text) if text == "*");
            let computed = wildcard || meets_criteria(&value_to_test, &criteria);
            if !computed {
                met = false;
                break;
            }
            met = true;
        }
        if met {
            values.push(number.clone());
        }
    }
    Ok(values)
}

/// `parseDate(value)`: a `Date` (possibly invalid) or the error it is. A number is a serial; text that is not a
/// number is read as a date.
pub fn parse_date(value: &Value) -> Value {
    if !is_nan_of(value) {
        if let Value::Date(time) = value {
            return Value::Date(*time);
        }
        let serial = parse_float_utf16(&to_js_utf16(value));
        if serial < 0.0 || serial >= 2_958_466.0 {
            return Value::Error(ErrorValue::Num);
        }
        return Value::Date(serial_to_date(serial));
    }
    if let Value::Utf16(raw) = value {
        let mut units = raw.clone();
        let iso = (8..=10).any(|length| units.len() >= length && String::from_utf16(&units[units.len() - length..]).is_ok_and(|s| ends_with_iso_day(&s)));
        if iso {
            units.extend("T00:00:00.000".encode_utf16());
        }
        let time = mixdog_js::time::date_parse_utf16(&units);
        return if time.is_nan() { Value::Error(ErrorValue::Value) } else { Value::Date(time) };
    }
    if let Value::Text(text) = value {
        let time = if ends_with_iso_day(text) { mixdog_js::time::date_parse(&format!("{text}T00:00:00.000")) } else { mixdog_js::time::date_parse(text) };
        if !time.is_nan() {
            return Value::Date(time);
        }
    }
    Value::Error(ErrorValue::Value)
}
/// `parseDateArray(values)`: the dates, or `#VALUE!`; an element out of the date range stays `#NUM!` inside the
/// result, as the library keeps it.
pub fn parse_date_array(values: &[Value]) -> Result<Vec<Value>, ErrorValue> {
    let mut parsed = values.to_vec();
    for at in (0..parsed.len()).rev() {
        let date = parse_date(&parsed[at]);
        if matches!(date, Value::Error(ErrorValue::Value)) {
            return Err(ErrorValue::Value);
        }
        parsed[at] = date;
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_js::time::{Tz, with_local_zone};

    fn n(number: f64) -> Value {
        Value::Number(number)
    }

    fn number_of(value: &Value) -> f64 {
        match value {
            Value::Number(number) => *number,
            other => panic!("not a number: {other:?}"),
        }
    }

    #[test]
    fn parse_number_follows_the_library() {
        assert_eq!(number_of(&parse_number(&Value::text("12.5"))), 12.5);
        assert!(matches!(parse_number(&Value::text("12.5abc")), Value::Error(ErrorValue::Value)));
        assert!(matches!(parse_number(&Value::text("abc")), Value::Error(ErrorValue::Value)));
        assert!(matches!(parse_number(&Value::text("")), Value::Error(ErrorValue::Value)));
        assert_eq!(number_of(&parse_number(&Value::Null)), 0.0);
        assert_eq!(number_of(&parse_number(&Value::Bool(true))), 1.0);
        // Number("0x10") is 16 but parseFloat("0x10") is 0: the library answers with parseFloat.
        assert_eq!(number_of(&parse_number(&Value::text("0x10"))), 0.0);
        // Number("  ") is 0, not NaN, and the text is not empty, so parseFloat("  ") answers NaN.
        assert!(number_of(&parse_number(&Value::text("  "))).is_nan());
        assert!(matches!(parse_number(&Value::Number(f64::NAN)), Value::Error(ErrorValue::Value)));
        assert!(matches!(parse_number(&Value::Number(-0.0)), Value::Number(zero) if zero.to_bits() == 0.0_f64.to_bits()));
        assert!(matches!(parse_number(&Value::Error(ErrorValue::Na)), Value::Error(ErrorValue::Na)));
        assert_eq!(number_of(&parse_number(&Value::text("1e3"))), 1000.0);
    }

    #[test]
    #[allow(clippy::approx_constant, reason = "3.14 is an input text sample, not a mathematical pi constant")]
    fn parse_float_reads_the_longest_prefix() {
        assert_eq!(parse_float("  3.14abc"), 3.14);
        assert_eq!(parse_float("-.5e1x"), -5.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert_eq!(parse_float("1e+"), 1.0);
        assert_eq!(parse_float("Infinityx"), f64::INFINITY);
        assert_eq!(parse_float("-Infinity"), f64::NEG_INFINITY);
        assert!(parse_float(".").is_nan());
        assert!(parse_float("abc").is_nan());
        assert!(parse_float("").is_nan());
        assert_eq!(parse_float("0x10"), 0.0);
    }

    #[test]
    fn flatten_splices_arrays_of_any_depth_in_order() {
        let nested = Value::Array(vec![n(1.0), Value::Array(vec![n(2.0), Value::Array(vec![n(3.0)])]), Value::Array(vec![])]);
        let flat = flatten(&[nested, n(4.0), Value::Array(vec![n(5.0)])]);
        let numbers: Vec<f64> = flat.iter().map(number_of).collect();
        assert_eq!(numbers, [1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(flatten(&[]).len(), 0);
        assert_eq!(flatten(&[Value::text("a")]).len(), 1);
    }

    #[test]
    fn parse_bool_and_string() {
        assert!(matches!(parse_bool(&Value::text("true")), Value::Bool(true)));
        assert!(matches!(parse_bool(&n(0.0)), Value::Bool(false)));
        assert!(matches!(parse_bool(&Value::text("yes")), Value::Error(ErrorValue::Value)));
        assert!(matches!(parse_bool(&Value::Date(0.0)), Value::Bool(true)));
        assert!(matches!(parse_bool(&Value::Date(f64::NAN)), Value::Error(ErrorValue::Value)));
        assert!(matches!(parse_string(&Value::Null), Value::Text(text) if text.is_empty()));
        assert!(matches!(parse_string(&n(1.5)), Value::Text(text) if text == "1.5"));
        assert!(matches!(parse_string(&Value::Bool(false)), Value::Text(text) if text == "false"));
    }

    #[test]
    fn serials_follow_the_1900_rules() {
        let seoul: Tz = "Asia/Seoul".parse().expect("zone");
        with_local_zone(seoul, || {
            let date = |serial: f64| match local_fields(serial_to_date(serial)) {
                Some(fields) => (fields.year, fields.month, fields.day, fields.hour),
                None => panic!("invalid date for {serial}"),
            };
            assert_eq!(date(1.0), (1900, 1, 1, 0));
            // formulajs increments 59 to 60 before applying its fake leap-day rollover.
            assert_eq!(date(59.0), (1900, 3, 1, 0));
            // The day Excel counts and the calendar does not have: the library's `new Date(1900, 1, 29)` rolls over.
            assert_eq!(date(60.0), (1900, 3, 1, 0));
            assert_eq!(date(61.0), (1900, 3, 1, 0));
            assert_eq!(date(45322.0), (2024, 1, 31, 0));
            assert_eq!(date(45322.5), (2024, 1, 31, 12));
            assert!(serial_to_date(f64::NAN).is_nan());
            assert_eq!(date_to_serial(local_to_utc_ms(2024, 1, 31, 0, 0, 0, 0)), 45322.0);
            assert_eq!(date_to_serial(local_to_utc_ms(1900, 1, 1, 0, 0, 0, 0)), 1.0);
        });
    }

    #[test]
    fn javascript_comparisons() {
        assert!(js_loose_equals(&n(1.0), &Value::text("1")));
        assert!(js_loose_equals(&Value::Bool(true), &n(1.0)));
        assert!(js_loose_equals(&Value::Null, &Value::Undefined));
        assert!(!js_loose_equals(&Value::Null, &n(0.0)));
        assert!(js_loose_equals(&Value::Array(vec![n(5.0)]), &n(5.0)));
        assert_eq!(js_less(&Value::text("10"), &Value::text("9")), Some(true));
        assert_eq!(js_less(&n(10.0), &Value::text("9")), Some(false));
        assert_eq!(js_less(&n(1.0), &Value::text("x")), None);
        assert_eq!(compare_utf16("\u{e000}", "\u{10000}"), Ordering::Greater);
    }

    #[test]
    fn criteria_read_operators_and_bare_values() {
        assert!(meets_criteria(&n(7.0), &Value::text(">5")));
        assert!(!meets_criteria(&n(5.0), &Value::text(">5")));
        assert!(meets_criteria(&n(5.0), &Value::text(">=5")));
        assert!(meets_criteria(&n(5.0), &n(5.0)));
        assert!(meets_criteria(&Value::text("a"), &Value::text("<>b")));
        assert!(meets_criteria(&n(3.0), &Value::text("=3")));
        assert!(!meets_criteria(&n(3.0), &Value::text("")));
        let values =
            apply_criteria(&[Value::Array(vec![n(1.0), n(2.0), n(3.0)]), Value::Array(vec![n(5.0), n(6.0), n(7.0)]), Value::text(">5")]).expect("values");
        assert_eq!(values.iter().map(number_of).collect::<Vec<_>>(), [2.0, 3.0]);
        assert!(apply_criteria(&[Value::Array(vec![])]).is_err());
    }

    #[test]
    fn matrices() {
        let matrix = Value::Array(vec![Value::Array(vec![n(1.0), Value::Null]), Value::Array(vec![n(2.0)])]);
        let Value::Array(rows) = fill_matrix(&matrix).expect("filled") else { panic!("rows") };
        assert!(matches!(&rows[0], Value::Array(row) if row.len() == 2 && number_of(&row[1]) == 0.0));
        assert!(matches!(&rows[1], Value::Array(row) if row.len() == 2 && number_of(&row[1]) == 0.0));
        let Value::Array(columns) = transpose(&matrix).expect("transposed") else { panic!("columns") };
        assert_eq!(columns.len(), 2);
        assert_eq!(get_matrix_size(&[Value::Array(vec![n(1.0), n(2.0)]), Value::Array(vec![n(3.0)])]), (2, 2));
        assert!(matches!(create_matrix(&n(0.0), &n(2.0)), Ok(Value::Error(ErrorValue::Value))));
        assert!(matches!(create_matrix(&Value::Undefined, &n(2.0)), Ok(Value::Error(ErrorValue::Na))));
        assert!(
            matches!(find_field(&[Value::Array(vec![Value::text("a")]), Value::Array(vec![Value::text("b")])], &Value::text("b")), Value::Number(at) if at == 1.0)
        );
    }

    #[test]
    fn errors_and_numbers() {
        assert_eq!(any_error(&[n(1.0), Value::Error(ErrorValue::Na), Value::Error(ErrorValue::Num)]), Some(ErrorValue::Na));
        assert!(any_is_error(&[Value::Error(ErrorValue::Ref)]));
        assert!(!any_is_error(&[Value::text("#N/A")]));
        assert_eq!(numbers(&[Value::Array(vec![n(1.0), Value::text("2"), Value::Bool(true)]), n(3.0)]), [1.0, 3.0]);
        assert_eq!(clean_float(0.1 + 0.2), 0.3);
        let mut mixed = [Value::Bool(true), Value::text("x"), Value::text("2"), Value::Null];
        array_values_to_numbers(&mut mixed);
        assert_eq!(number_of(&mixed[0]), 1.0);
        assert_eq!(number_of(&mixed[1]), 0.0);
        assert_eq!(number_of(&mixed[2]), 2.0);
        assert!(matches!(mixed[3], Value::Null));
    }

    #[test]
    fn matrix_dimensions_follow_array_from_tolength_before_allocating() {
        let number = Value::Number;
        for (rows, columns) in [(f64::INFINITY, f64::NAN), (f64::INFINITY, 0.5), (4_294_967_296.0, 1.0), (1.0, f64::INFINITY)] {
            assert_eq!(create_matrix(&number(rows), &number(columns)), Err(Failure::thrown("Invalid array length")));
        }
        assert_eq!(create_matrix(&number(f64::NAN), &number(2.0)), Ok(Value::Array(vec![])));
        assert_eq!(create_matrix(&number(0.5), &number(f64::INFINITY)), Ok(Value::Array(vec![])));
        assert_eq!(create_matrix(&number(2.0), &number(f64::NAN)), Ok(Value::Array(vec![Value::Array(vec![]), Value::Array(vec![])])));
        assert_eq!(
            create_matrix(&number(2.9), &number(1.9)),
            Ok(Value::Array(vec![Value::Array(vec![Value::Undefined]), Value::Array(vec![Value::Undefined])]))
        );
        assert_eq!(create_matrix(&number(0.0), &number(2.0)), Ok(Value::Error(ErrorValue::Value)));
        assert_eq!(create_matrix(&Value::Undefined, &number(2.0)), Ok(Value::Error(ErrorValue::Na)));
    }

    #[test]
    fn parse_date_reads_serials_and_text() {
        let seoul: Tz = "Asia/Seoul".parse().expect("zone");
        with_local_zone(seoul, || {
            let ms = |value: Value| match parse_date(&value) {
                Value::Date(time) => time,
                other => panic!("not a date: {other:?}"),
            };
            assert_eq!(ms(n(45322.0)), local_to_utc_ms(2024, 1, 31, 0, 0, 0, 0));
            assert_eq!(ms(Value::text("2024-01-05")), local_to_utc_ms(2024, 1, 5, 0, 0, 0, 0));
            assert!(matches!(parse_date(&n(-1.0)), Value::Error(ErrorValue::Num)));
            assert!(matches!(parse_date(&n(2_958_466.0)), Value::Error(ErrorValue::Num)));
            assert!(matches!(parse_date(&Value::text("not a date")), Value::Error(ErrorValue::Value)));
            assert!(matches!(parse_date(&Value::Undefined), Value::Error(ErrorValue::Value)));
            assert!(ends_with_iso_day("on 2024-01-31") && ends_with_iso_day("2024-1-3"));
            assert!(!ends_with_iso_day("2024-01-311") && !ends_with_iso_day("24-01-31"));
        });
    }
}
