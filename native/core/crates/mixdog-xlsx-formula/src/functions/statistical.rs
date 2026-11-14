//! Descriptive statistics from @formulajs/formulajs 4.6.1 (index.mjs 2448-5478).
//! Keep each function's own coercions and iteration order. Elementary jStat
//! reductions below are copied in their original order; no distribution/special
//! function implementation or dependency is shared with the distribution task.
use crate::coerce::{
    any_error, apply_criteria, array_values_to_numbers, clean_float, flatten, is_defined,
    is_truthy, meets_criteria, numbers, parse_number, parse_number_array, to_js_number,
};
use crate::registry::Table;
use crate::value::{ErrorValue, Failure, Value};
use mixdog_js::{js_sort_by, math, number_to_string};

fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Undefined)
}
fn numeric(value: &Value) -> Result<f64, ErrorValue> {
    match parse_number(value) {
        Value::Number(n) => Ok(n),
        Value::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
fn array(value: &Value) -> Result<Vec<f64>, ErrorValue> {
    parsed(&flatten(std::slice::from_ref(value)))
}
fn parsed(values: &[Value]) -> Result<Vec<f64>, ErrorValue> {
    parse_number_array(values).map(|values| values.iter().map(to_js_number).collect())
}
fn all(args: &[Value]) -> Result<Vec<f64>, ErrorValue> {
    parsed(&flatten(args))
}
fn values(numbers: Vec<f64>) -> Value {
    Value::Array(numbers.into_iter().map(Value::Number).collect())
}
fn at(array: &[f64], index: usize) -> f64 {
    array.get(index).copied().unwrap_or(f64::NAN)
}
fn property(array: &[f64], index: f64) -> Value {
    if index.is_finite() && index >= 0.0 && index.fract() == 0.0 {
        array
            .get(index as usize)
            .copied()
            .map(Value::Number)
            .unwrap_or(Value::Undefined)
    } else {
        Value::Undefined
    }
}
fn sort(array: &mut Vec<f64>, ascending: bool) {
    js_sort_by(array, |a, b| if ascending { a - b } else { b - a });
}
fn wildcard(value: &Value) -> bool {
    matches!(value, Value::Undefined) || matches!(value, Value::Text(s) if s == "*")
}
fn number_or_num(value: f64) -> Value {
    if value.is_nan() {
        Value::Error(ErrorValue::Num)
    } else {
        Value::Number(value)
    }
}
// jStat.sum/mean/sumsqerr run from the end, unlike formulajs' forward loops.
fn jsum(array: &[f64]) -> f64 {
    let mut sum = 0.0;
    for &x in array.iter().rev() {
        sum += x;
    }
    sum
}
fn mean(array: &[f64]) -> f64 {
    jsum(array) / array.len() as f64
}
fn jstdev(array: &[f64]) -> f64 {
    let average = mean(array);
    let mut sum = 0.0;
    for &x in array.iter().rev() {
        let delta = x - average;
        sum += delta * delta;
    }
    (sum / (array.len() as f64 - 1.0)).sqrt()
}
fn regression(y: &[f64], x: &[f64], measure_y: bool) -> (f64, f64, f64, f64, f64) {
    let ym = mean(y);
    let xm = mean(x);
    let mut num = 0.0;
    let mut den = 0.0;
    let mut left = 0.0;
    for (i, &xi) in x.iter().enumerate() {
        if measure_y {
            left += math::pow(at(y, i) - ym, 2.0);
        }
        num += (xi - xm) * (at(y, i) - ym);
        den += math::pow(xi - xm, 2.0);
    }
    let slope = num / den;
    (slope, ym - slope * xm, left, num, den)
}
macro_rules! original {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Ok(Value::Error(e)),
        }
    };
}
macro_rules! value_error {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(_) => return Ok(Value::Error(ErrorValue::Value)),
        }
    };
}

fn average(args: &[Value], logical: bool) -> Value {
    let flat: Vec<Value> = flatten(args).into_iter().filter(is_defined).collect();
    if flat.is_empty() {
        return Value::Error(ErrorValue::Div0);
    }
    if let Some(error) = any_error(&flat) {
        return Value::Error(error);
    }
    let mut sum = 0.0;
    let mut count = 0.0;
    for value in &flat {
        match value {
            Value::Number(n) => {
                sum += n;
                if !logical {
                    count += 1.0;
                }
            }
            Value::Bool(true) if logical => sum += 1.0,
            _ => {}
        }
        if logical && !matches!(value, Value::Null) {
            count += 1.0;
        }
    }
    number_or_num(sum / count)
}
fn variance(args: &[Value], logical: bool, population: bool) -> Value {
    let flat = if logical {
        flatten(args)
    } else {
        numbers(args).into_iter().map(Value::Number).collect()
    };
    let average = to_js_number(&average(&[Value::Array(flat.clone())], logical));
    let mut sigma = 0.0;
    let mut count = 0.0;
    for value in &flat {
        let x = match value {
            Value::Number(n) => *n,
            Value::Bool(true) => 1.0,
            _ => 0.0,
        };
        sigma += math::pow(x - average, 2.0);
        if !matches!(value, Value::Null) {
            count += 1.0;
        }
    }
    let result = sigma / (count - if population { 0.0 } else { 1.0 });
    if population {
        number_or_num(result)
    } else {
        Value::Number(result)
    }
}
fn percentile(mut array: Vec<f64>, k: f64, exclusive: bool) -> Value {
    sort(&mut array, true);
    let n = array.len() as f64;
    if exclusive && (k < 1.0 / (n + 1.0) || k > 1.0 - 1.0 / (n + 1.0)) {
        return Value::Error(ErrorValue::Num);
    }
    let l = if exclusive {
        k * (n + 1.0) - 1.0
    } else {
        k * (n - 1.0)
    };
    let fl = l.floor();
    let answer = if l == fl {
        to_js_number(&property(&array, l))
    } else {
        to_js_number(&property(&array, fl))
            + (l - fl)
                * (to_js_number(&property(&array, fl + 1.0)) - to_js_number(&property(&array, fl)))
    };
    Value::Number(clean_float(answer))
}
fn mode(array: &[f64]) -> Vec<f64> {
    let mut counts = std::collections::HashMap::<String, usize>::new();
    let mut max = 0;
    let mut result = Vec::new();
    for &item in array {
        let count = counts.entry(number_to_string(item)).or_default();
        *count += 1;
        if *count > max {
            max = *count;
            result.clear();
        }
        if *count == max {
            result.push(item);
        }
    }
    result
}
// FACT recurses down to 1, multiplying on return. Negative or infinite arguments
// never reach the base case in Node and throw RangeError instead of terminating.
fn factorial(n: f64) -> Result<f64, Failure> {
    if n.is_nan() {
        return Ok(f64::NAN);
    }
    if n < 0.0 || n.is_infinite() {
        return Err(Failure::thrown("Maximum call stack size exceeded"));
    }
    let n = n.floor();
    if n > 1.0 && n - 1.0 == n {
        return Err(Failure::thrown("Maximum call stack size exceeded"));
    }
    // The memoized source has reached +Infinity by 171; further products stay so.
    let mut value = 1.0;
    for i in 2..=(n.min(171.0) as u32) {
        value *= f64::from(i);
    }
    Ok(value)
}
// The source's direct parseNumberArray (INTERCEPT only), not flatten().
fn direct_array(value: &Value) -> Result<Value, Failure> {
    match value {
        Value::Array(items) => Ok(match parse_number_array(items) {
            Ok(v) => Value::Array(v),
            Err(e) => Value::Error(e),
        }),
        Value::Text(text) if !text.is_empty() => {
            let chars: Vec<_> = text.encode_utf16().collect();
            let index = chars.len() - 1;
            let last = String::from_utf16_lossy(&chars[index..index + 1]);
            if let Value::Error(e) = parse_number(&Value::Text(last)) {
                return Ok(Value::Error(e));
            }
            Err(Failure::thrown(format!(
                "Cannot assign to read only property '{index}' of string '{text}'"
            )))
        }
        other if !is_truthy(other) => Ok(Value::Error(ErrorValue::Value)),
        other => Ok(other.clone()),
    }
}
fn array_length(value: &Value) -> Option<usize> {
    match value {
        Value::Array(a) => Some(a.len()),
        Value::Text(s) => Some(s.encode_utf16().count()),
        _ => None,
    }
}

fn run(name: &str, args: &[Value]) -> Result<Value, Failure> {
    let result = match name {
        "AVEDEV" => {
            let flat: Vec<_> = flatten(args).into_iter().filter(is_defined).collect();
            if flat.is_empty() {
                return Ok(Value::Error(ErrorValue::Num));
            }
            let a = original!(parsed(&flat));
            let m = mean(&a);
            Value::Number(
                jsum(&a.iter().map(|x| (x - m).abs()).collect::<Vec<_>>()) / a.len() as f64,
            )
        }
        "AVERAGE" => average(args, false),
        "AVERAGEA" => average(args, true),
        "AVERAGEIF" => {
            if args.len() <= 1 {
                return Ok(Value::Error(ErrorValue::Na));
            }
            let raw = if is_truthy(arg(args, 2)) {
                arg(args, 2)
            } else {
                arg(args, 0)
            };
            let defined: Vec<_> = flatten(std::slice::from_ref(raw))
                .into_iter()
                .filter(is_defined)
                .collect();
            let averages = original!(parsed(&defined));
            let range = flatten(&[arg(args, 0).clone()]);
            let criteria = arg(args, 1);
            let mut count = 0.0;
            let mut sum = 0.0;
            for (i, value) in range.iter().enumerate() {
                if wildcard(criteria) || meets_criteria(value, criteria) {
                    sum += at(&averages, i);
                    count += 1.0;
                }
            }
            Value::Number(sum / count)
        }
        "AVERAGEIFS" | "MAXIFS" | "MINIFS" => {
            let empty_args = [Value::Undefined];
            let selected = match apply_criteria(if args.is_empty() { &empty_args } else { args }) {
                Ok(values) => values,
                Err(_) if name == "AVERAGEIFS" => {
                    return Err(Failure::thrown("values.reduce is not a function"));
                }
                // An Error's length is undefined; Math.max/min.apply reads it as
                // an empty array-like object, giving -/+Infinity.
                Err(_) => {
                    return Ok(Value::Number(if name == "MAXIFS" {
                        f64::NEG_INFINITY
                    } else {
                        f64::INFINITY
                    }));
                }
            };
            if name == "AVERAGEIFS" {
                let sum = selected.iter().fold(0.0, |sum, x| sum + to_js_number(x));
                let avg = sum / selected.len() as f64;
                Value::Number(if avg.is_nan() { 0.0 } else { avg })
            } else {
                extreme(
                    selected.iter().map(to_js_number),
                    name == "MAXIFS",
                    selected.is_empty(),
                )
            }
        }
        "COUNT" => Value::Number(numbers(args).len() as f64),
        "COUNTA" | "COUNTBLANK" => {
            let a = flatten(args);
            let count = a
                .iter()
                .filter(|v| {
                    matches!(v, Value::Undefined | Value::Null)
                        || matches!(v, Value::Text(s) if s.is_empty())
                })
                .count();
            Value::Number(if name == "COUNTBLANK" {
                count
            } else {
                a.len() - count
            } as f64)
        }
        "COUNTIF" => {
            let a = flatten(&[arg(args, 0).clone()]);
            let c = arg(args, 1);
            Value::Number(
                a.iter()
                    .filter(|v| wildcard(c) || meets_criteria(v, c))
                    .count() as f64,
            )
        }
        "COUNTIFS" => {
            let mut result = vec![true; flatten(&[arg(args, 0).clone()]).len()];
            for i in (0..args.len()).step_by(2) {
                let a = flatten(&[arg(args, i).clone()]);
                let c = arg(args, i + 1);
                if !wildcard(c) {
                    if a.len() > result.len() {
                        result.resize(a.len(), false);
                    }
                    for (j, v) in a.iter().enumerate() {
                        result[j] = result[j] && meets_criteria(v, c);
                    }
                }
            }
            Value::Number(result.iter().filter(|v| **v).count() as f64)
        }
        "CORREL" | "COVARIANCE.P" | "COVARIANCE.S" | "PEARSON" | "RSQ" => {
            let a = value_error!(array(arg(args, 0)));
            let b = value_error!(array(arg(args, 1)));
            let am = mean(&a);
            let bm = mean(&b);
            let n = a.len() as f64;
            let mut numerator = 0.0;
            let mut d1 = 0.0;
            let mut d2 = 0.0;
            let mut products = Vec::new();
            for (i, &x) in a.iter().enumerate() {
                let product = (x - am) * (at(&b, i) - bm);
                products.push(product);
                numerator += product;
                d1 += math::pow(x - am, 2.0);
                d2 += math::pow(at(&b, i) - bm, 2.0);
            }
            Value::Number(match name {
                "COVARIANCE.P" => numerator / n,
                "COVARIANCE.S" => jsum(&products) / (n - 1.0),
                "CORREL" => jsum(&products) / (n - 1.0) / jstdev(&a) / jstdev(&b),
                "RSQ" => math::pow(numerator / (d1 * d2).sqrt(), 2.0),
                _ => numerator / (d1 * d2).sqrt(),
            })
        }
        "DEVSQ" | "KURT" | "SKEW" | "SKEW.P" | "GEOMEAN" | "HARMEAN" => {
            let a = original!(all(args));
            let n = a.len() as f64;
            let m = mean(&a);
            if name == "GEOMEAN" {
                Value::Number(math::exp(mean(
                    &a.iter().map(|x| math::ln(*x)).collect::<Vec<_>>(),
                )))
            } else if name == "HARMEAN" {
                let mut den = 0.0;
                for x in a {
                    den += 1.0 / x;
                }
                Value::Number(n / den)
            } else {
                let power = if name == "KURT" {
                    4.0
                } else if name == "DEVSQ" {
                    2.0
                } else {
                    3.0
                };
                let mut sigma = 0.0;
                let mut m2 = 0.0;
                for &x in &a {
                    sigma += math::pow(x - m, power);
                    m2 += math::pow(x - m, 2.0);
                }
                Value::Number(match name {
                    "DEVSQ" => sigma,
                    "KURT" => {
                        sigma /= math::pow(jstdev(&a), 4.0);
                        (n * (n + 1.0) / ((n - 1.0) * (n - 2.0) * (n - 3.0))) * sigma
                            - (3.0 * (n - 1.0) * (n - 1.0)) / ((n - 2.0) * (n - 3.0))
                    }
                    "SKEW" => n * sigma / ((n - 1.0) * (n - 2.0) * math::pow(jstdev(&a), 3.0)),
                    _ => (sigma / n) / math::pow(m2 / n, 3.0 / 2.0),
                })
            }
        }
        "FISHER" | "FISHERINV" => {
            let x = original!(numeric(arg(args, 0)));
            Value::Number(if name == "FISHER" {
                math::ln((1.0 + x) / (1.0 - x)) / 2.0
            } else {
                let e = math::exp(2.0 * x);
                (e - 1.0) / (e + 1.0)
            })
        }
        "FORECAST" | "LINEST" | "SLOPE" | "STEYX" | "TREND" | "LOGEST" | "INTERCEPT" => {
            regression_call(name, args)?
        }
        "FREQUENCY" => {
            let data = value_error!(array(arg(args, 0)));
            let bins = value_error!(array(arg(args, 1)));
            let mut result = vec![0.0; bins.len() + 1];
            for (i, count) in result.iter_mut().enumerate() {
                for &x in &data {
                    if (i == 0 && x <= at(&bins, 0))
                        || (i > 0 && i < bins.len() && x > at(&bins, i - 1) && x <= at(&bins, i))
                        || (i > 0 && i == bins.len() && x > at(&bins, i - 1))
                    {
                        *count += 1.0;
                    }
                }
            }
            values(result)
        }
        "GROWTH" => growth(args)?,
        "MAX" | "MIN" | "MAXA" | "MINA" => {
            let mut a = flatten(args);
            if let Some(error) = any_error(&a) {
                return Ok(Value::Error(error));
            }
            let logical = name.ends_with('A');
            let max = name.starts_with("MAX");
            if logical {
                array_values_to_numbers(&mut a);
                let n: Vec<_> = a
                    .iter()
                    .map(|v| {
                        if matches!(v, Value::Undefined | Value::Null) {
                            0.0
                        } else {
                            to_js_number(v)
                        }
                    })
                    .collect();
                extreme(n.iter().copied(), max, n.is_empty())
            } else {
                let n = numbers(&a);
                extreme(n.iter().copied(), max, n.is_empty())
            }
        }
        "MEDIAN" => {
            let mut a = flatten(args);
            if let Some(error) = any_error(&a) {
                return Ok(Value::Error(error));
            }
            array_values_to_numbers(&mut a);
            // Array.sort moves undefined behind all comparator-visible values.
            let undefined = a.iter().filter(|v| matches!(v, Value::Undefined)).count();
            a.retain(|v| !matches!(v, Value::Undefined));
            js_sort_by(&mut a, |a, b| to_js_number(a) - to_js_number(b));
            a.extend(std::iter::repeat_n(Value::Undefined, undefined));
            let get = |i: usize| a.get(i).cloned().unwrap_or(Value::Undefined);
            let len = a.len();
            let middle = if len % 2 == 1 {
                get(len / 2)
            } else {
                let left = get((len / 2).wrapping_sub(1));
                let right = get(len / 2);
                // Date's default primitive is text; `date + date` concatenates,
                // and the following division produces NaN, not a time average.
                Value::Number(
                    if matches!(left, Value::Date(_)) || matches!(right, Value::Date(_)) {
                        f64::NAN
                    } else {
                        (to_js_number(&left) + to_js_number(&right)) / 2.0
                    },
                )
            };
            if to_js_number(&middle).is_nan() {
                Value::Error(ErrorValue::Num)
            } else {
                middle
            }
        }
        "MODE.MULT" | "MODE.SNGL" => {
            let a = original!(all(args));
            // MODE.SNGL reparses through MODE.MULT. A NaN produced by a
            // whitespace/date conversion now becomes an Error, on which the
            // source's subsequent .sort() throws.
            if name == "MODE.SNGL" && a.iter().any(|n| n.is_nan()) {
                return Err(Failure::thrown("MODE.MULT(...).sort is not a function"));
            }
            let mut modes = mode(&a);
            if name == "MODE.SNGL" {
                sort(&mut modes, true);
                property(&modes, 0.0)
            } else {
                values(modes)
            }
        }
        "LARGE" => {
            match arg(args, 0) {
                Value::Array(a) => {
                    if let Some(e) = any_error(a) {
                        return Ok(Value::Error(e));
                    }
                }
                Value::Undefined | Value::Null | Value::Date(_) | Value::Error(_) => {}
                _ => {
                    return Err(Failure::thrown(
                        "CreateListFromArrayLike called on non-object",
                    ));
                }
            }
            if let Value::Error(e) = arg(args, 1) {
                return Ok(Value::Error(*e));
            }
            let mut a = numbers(&[arg(args, 0).clone()]);
            let k = to_js_number(&parse_number(arg(args, 1)));
            if k < 0.0 || (a.len() as f64) < k {
                Value::Error(ErrorValue::Value)
            } else {
                sort(&mut a, false);
                property(&a, k - 1.0)
            }
        }
        "SMALL" => {
            let parsed_array = array(arg(args, 0));
            let k = numeric(arg(args, 1));
            match (parsed_array, k) {
                (Err(e), _) => Value::Error(e),
                (Ok(a), Err(_)) => values(a),
                (Ok(mut a), Ok(k)) => {
                    sort(&mut a, true);
                    property(&a, k - 1.0)
                }
            }
        }
        "PERCENTILE.EXC" | "PERCENTILE.INC" => {
            let a = value_error!(array(arg(args, 0)));
            let k = value_error!(numeric(arg(args, 1)));
            percentile(a, k, name.ends_with("EXC"))
        }
        "PERCENTRANK.EXC" | "PERCENTRANK.INC" => percentrank(name.ends_with("EXC"), args)?,
        "QUARTILE.EXC" | "QUARTILE.INC" => {
            let a = value_error!(parsed(
                &numbers(&[arg(args, 0).clone()])
                    .into_iter()
                    .map(Value::Number)
                    .collect::<Vec<_>>()
            ));
            let q = value_error!(numeric(arg(args, 1)));
            if q == 1.0 || q == 2.0 || q == 3.0 {
                percentile(a, q / 4.0, name.ends_with("EXC"))
            } else {
                Value::Error(ErrorValue::Num)
            }
        }
        "RANK.AVG" | "RANK.EQ" => {
            let n = value_error!(numeric(arg(args, 0)));
            let mut a = value_error!(array(arg(args, 1)));
            sort(&mut a, is_truthy(arg(args, 2)));
            let index = a.iter().position(|x| *x == n).map_or(-1.0, |i| i as f64);
            let count = a.iter().filter(|x| **x == n).count() as f64;
            Value::Number(if name == "RANK.AVG" && count > 1.0 {
                (2.0 * index + count + 1.0) / 2.0
            } else {
                index + 1.0
            })
        }
        "PERMUT" | "PERMUTATIONA" => {
            let n = value_error!(numeric(arg(args, 0)));
            let k = value_error!(numeric(arg(args, 1)));
            Value::Number(if name == "PERMUT" {
                factorial(n)? / factorial(n - k)?
            } else {
                math::pow(n, k)
            })
        }
        "STANDARDIZE" => {
            let x = value_error!(numeric(arg(args, 0)));
            let mean = value_error!(numeric(arg(args, 1)));
            let deviation = value_error!(numeric(arg(args, 2)));
            Value::Number((x - mean) / deviation)
        }
        "VAR.P" | "VAR.S" | "VARA" | "VARPA" => variance(
            args,
            name == "VARA" || name == "VARPA",
            name == "VAR.P" || name == "VARPA",
        ),
        "STDEV.P" | "STDEV.S" | "STDEVA" | "STDEVPA" => {
            let population = name == "STDEV.P" || name == "STDEVPA";
            let v = variance(args, name == "STDEVA" || name == "STDEVPA", population);
            let result = to_js_number(&v).sqrt();
            if population {
                number_or_num(result)
            } else {
                Value::Number(result)
            }
        }
        "TRIMMEAN" => {
            let mut a = value_error!(array(arg(args, 0)));
            let p = value_error!(numeric(arg(args, 1)));
            sort(&mut a, true);
            // FLOOR(n*p,2)/2, followed by rest/initial, whose `idx || 1`
            // makes a zero trim remove one item from EACH end in this library.
            let trim = ((a.len() as f64 * p / 2.0).floor() * 2.0) / 2.0;
            let trim = if trim == 0.0 || trim.is_nan() {
                1.0
            } else {
                trim
            };
            let start = slice_index(trim, a.len());
            let rest = &a[start..];
            let end = slice_index(rest.len() as f64 - trim, rest.len());
            Value::Number(mean(&rest[..end]))
        }
        _ => unreachable!("registered descriptive statistic"),
    };
    Ok(result)
}
fn extreme(iter: impl Iterator<Item = f64>, maximum: bool, empty: bool) -> Value {
    if empty {
        return Value::Number(0.0);
    }
    Value::Number(iter.fold(
        if maximum {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        },
        |a, b| {
            if maximum {
                math::max(a, b)
            } else {
                math::min(a, b)
            }
        },
    ))
}
fn slice_index(index: f64, length: usize) -> usize {
    let n = length as f64;
    if index < 0.0 {
        (n + index.trunc()).max(0.0) as usize
    } else {
        index.trunc().min(n).max(0.0) as usize
    }
}
fn regression_call(name: &str, args: &[Value]) -> Result<Value, Failure> {
    let offset = usize::from(name == "FORECAST");
    let forecast_x = if offset == 1 {
        value_error!(numeric(arg(args, 0)))
    } else {
        0.0
    };
    let (y, x) = if name == "INTERCEPT" {
        let y = direct_array(arg(args, 0))?;
        let x = direct_array(arg(args, 1))?;
        if matches!(y, Value::Error(_)) || matches!(x, Value::Error(_)) {
            return Ok(Value::Error(ErrorValue::Value));
        }
        if array_length(&y) != array_length(&x) {
            return Ok(Value::Error(ErrorValue::Na));
        }
        (value_error!(array(&y)), value_error!(array(&x)))
    } else {
        (
            value_error!(array(arg(args, offset))),
            value_error!(array(arg(args, offset + 1))),
        )
    };
    let new_x = if name == "TREND" {
        Some(value_error!(array(arg(args, 2))))
    } else {
        None
    };
    if name == "LOGEST" && y.len() != x.len() {
        return Ok(Value::Error(ErrorValue::Value));
    }
    let y = if name == "LOGEST" {
        y.into_iter().map(math::ln).collect::<Vec<_>>()
    } else {
        y
    };
    // LOGEST calls LINEST, which reparses both arrays: negative y or an x
    // whose first conversion produced NaN becomes #VALUE! on the second pass.
    if name == "LOGEST" && y.iter().chain(x.iter()).any(|n| n.is_nan()) {
        return Ok(Value::Error(ErrorValue::Value));
    }
    let (slope, intercept, left, numerator, denominator) = regression(&y, &x, name == "STEYX");
    Ok(match name {
        "SLOPE" => Value::Number(slope),
        "FORECAST" | "INTERCEPT" => Value::Number(intercept + slope * forecast_x),
        "LINEST" => values(vec![slope, intercept]),
        "LOGEST" => values(vec![
            math::round(math::exp(slope) * 1_000_000.0) / 1_000_000.0,
            math::round(math::exp(intercept) * 1_000_000.0) / 1_000_000.0,
        ]),
        "TREND" => values(
            new_x
                .unwrap()
                .into_iter()
                .map(|x| slope * x + intercept)
                .collect(),
        ),
        "STEYX" => Value::Number(
            ((left - (numerator * numerator) / denominator) / (x.len() as f64 - 2.0)).sqrt(),
        ),
        _ => unreachable!(),
    })
}
fn growth(args: &[Value]) -> Result<Value, Failure> {
    let y = original!(array(arg(args, 0)));
    let x_raw = if matches!(arg(args, 1), Value::Undefined) {
        values((1..=y.len()).map(|n| n as f64).collect())
    } else {
        arg(args, 1).clone()
    };
    let new_raw = if matches!(arg(args, 2), Value::Undefined) {
        &x_raw
    } else {
        arg(args, 2)
    };
    let x = value_error!(array(&x_raw));
    let new_x = value_error!(array(new_raw));
    let constant = matches!(arg(args, 3), Value::Undefined) || is_truthy(arg(args, 3));
    let (mut ax, mut ay, mut axy, mut axx) = (0.0, 0.0, 0.0, 0.0);
    for (i, &yi) in y.iter().enumerate() {
        let xi = at(&x, i);
        let yi = math::ln(yi);
        ax += xi;
        ay += yi;
        axy += xi * yi;
        axx += xi * xi;
    }
    let n = y.len() as f64;
    ax /= n;
    ay /= n;
    axy /= n;
    axx /= n;
    let beta = if constant {
        (axy - ax * ay) / (axx - ax * ax)
    } else {
        axy / axx
    };
    let alpha = if constant { ay - beta * ax } else { 0.0 };
    Ok(values(
        new_x
            .into_iter()
            .map(|x| math::exp(alpha + beta * x))
            .collect(),
    ))
}
fn percentrank(exclusive: bool, args: &[Value]) -> Result<Value, Failure> {
    let mut a = value_error!(array(arg(args, 0)));
    let x = value_error!(numeric(arg(args, 1)));
    let significance = if matches!(arg(args, 2), Value::Undefined) {
        3.0
    } else {
        value_error!(numeric(arg(args, 2)))
    };
    sort(&mut a, true);
    let mut unique = Vec::new();
    for &n in &a {
        if !unique.contains(&n) {
            unique.push(n);
        }
    }
    let mut result = 0.0;
    let denominator = a.len() as f64 + if exclusive { 1.0 } else { -1.0 };
    for (i, &n) in unique.iter().enumerate() {
        let position = a.iter().position(|v| *v == n).map_or(-1.0, |i| i as f64)
            + if exclusive { 1.0 } else { 0.0 };
        if x == n {
            result = position / denominator;
            break;
        }
        if x >= n && (x < at(&unique, i + 1) || i == unique.len() - 1) {
            result = (position + (x - n) / (at(&unique, i + 1) - n)) / denominator;
            break;
        }
    }
    let power = math::pow(10.0, significance);
    Ok(Value::Number((result * power).floor() / power))
}

macro_rules! functions { ($( $rust:ident => $name:literal ),+ $(,)?) => {
    $(fn $rust(args: &[Value]) -> Result<Value, Failure> { run($name, args) })+
    pub const FUNCTIONS: Table = &[$(($name, $rust)),+];
}; }
functions! {
    avedev => "AVEDEV", average_fn => "AVERAGE", averagea => "AVERAGEA", averageif => "AVERAGEIF", averageifs => "AVERAGEIFS",
    correl => "CORREL", count => "COUNT", counta => "COUNTA", countblank => "COUNTBLANK", countif => "COUNTIF", countifs => "COUNTIFS",
    covariance_p => "COVARIANCE.P", covariance_s => "COVARIANCE.S", devsq => "DEVSQ", fisher => "FISHER", fisherinv => "FISHERINV", forecast => "FORECAST",
    frequency => "FREQUENCY", geomean => "GEOMEAN", growth_fn => "GROWTH", harmean => "HARMEAN", intercept => "INTERCEPT", kurt => "KURT",
    large => "LARGE", linest => "LINEST", logest => "LOGEST", max => "MAX", maxa => "MAXA", maxifs => "MAXIFS", median => "MEDIAN", min => "MIN", mina => "MINA", minifs => "MINIFS",
    mode_mult => "MODE.MULT", mode_sngl => "MODE.SNGL", pearson => "PEARSON", percentile_exc => "PERCENTILE.EXC", percentile_inc => "PERCENTILE.INC",
    percentrank_exc => "PERCENTRANK.EXC", percentrank_inc => "PERCENTRANK.INC", permut => "PERMUT", permutationa => "PERMUTATIONA", quartile_exc => "QUARTILE.EXC", quartile_inc => "QUARTILE.INC",
    rank_avg => "RANK.AVG", rank_eq => "RANK.EQ", rsq => "RSQ", skew => "SKEW", skew_p => "SKEW.P", slope => "SLOPE", small => "SMALL", standardize => "STANDARDIZE",
    stdev_p => "STDEV.P", stdev_s => "STDEV.S", stdeva => "STDEVA", stdevpa => "STDEVPA", steyx => "STEYX", trend => "TREND", trimmean => "TRIMMEAN", var_p => "VAR.P", var_s => "VAR.S", vara => "VARA", varpa => "VARPA",
}
