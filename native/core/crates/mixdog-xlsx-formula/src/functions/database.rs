//! Formulajs databases are arrays of field columns, not row-oriented Excel tables.
use super::text::arg;
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};

macro_rules! functions { ($($name:ident),*) => { $(fn $name(a:&[V])->Result<V,Failure>{run(stringify!($name),a)})* pub const FUNCTIONS:Table=&[$((stringify!($name),$name)),*]; }; }
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        DAVERAGE, DCOUNT, DCOUNTA, DGET, DMAX, DMIN, DPRODUCT, DSTDEV, DSTDEVP, DSUM, DVAR, DVARP
    );
}
pub use exports::FUNCTIONS;
fn column(v: &V) -> &[V] {
    if let V::Array(v) = v { v } else { &[] }
}
fn add(a: V, b: &V) -> V {
    if matches!(a, V::Text(_)) || matches!(b, V::Text(_)) {
        V::Text(to_js_string(&a) + &to_js_string(b))
    } else {
        V::Number(to_js_number(&a) + to_js_number(b))
    }
}
fn less(a: &V, b: &V) -> bool {
    match (a, b) {
        (V::Text(x), V::Text(y)) => compare_utf16(x, y).is_lt(),
        _ => to_js_number(a) < to_js_number(b),
    }
}
fn sum(a: &[V]) -> V {
    let mut n = 0.0;
    for v in flatten(a) {
        match v {
            V::Error(e) => return V::Error(e),
            V::Number(x) => n += x,
            V::Text(s) => {
                let x = parse_float(&s);
                if !x.is_nan() {
                    n += x
                }
            }
            _ => {}
        }
    }
    V::Number(n)
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let (database, field, criteria) = (arg(a, 0), arg(a, 1), arg(a, 2));
    if is_nan_of(&field) && !matches!(field, V::Text(_)) {
        return Ok(V::Error(E::Value));
    }
    let db = column(&database);
    let cs = column(&criteria);
    if db.is_empty() {
        return Err(Failure::thrown(
            "Cannot read properties of undefined (reading 'length')",
        ));
    }
    if cs.is_empty() {
        return Err(Failure::thrown(
            "Cannot read properties of undefined (reading 'length')",
        ));
    }
    let len = column(&db[0]).len();
    let mut matched = vec![true; len];
    if !matched.is_empty() {
        matched[0] = false
    }
    let longest = cs.iter().map(|v| column(v).len()).max().unwrap_or(0);
    // Deliberately starts at field 1: the source's first column is excluded from criteria evaluation.
    for col in db.iter().skip(1) {
        let col = column(col);
        for (i, value) in col.iter().enumerate().skip(1) {
            let mut has = false;
            let mut passes = false;
            for criterion in cs.iter().map(column).filter(|c| c.len() >= longest) {
                if !js_strict_equals(
                    col.first().unwrap_or(&V::Undefined),
                    criterion.first().unwrap_or(&V::Undefined),
                ) {
                    continue;
                }
                has = true;
                for c in criterion.iter().skip(1) {
                    if !passes {
                        passes = matches!(c, V::Undefined)
                            || matches!(c,V::Text(s) if s=="*")
                            || meets_criteria(value, &V::Text(to_js_string(c)));
                    }
                }
            }
            if has && i < matched.len() {
                matched[i] &= passes
            }
        }
    }
    let index = if matches!(field, V::Text(_)) {
        find_field(db, &field)
    } else {
        field
    };
    let ix = to_js_number(&index);
    let target = if ix.is_finite() && ix >= 0.0 && ix.fract() == 0.0 {
        db.get(ix as usize)
    } else {
        None
    };
    // utils.rest(undefined) returns undefined, then a selected record's property access throws.
    let selected: Vec<_> = (1..len).filter(|i| matched[*i]).collect();
    if target.is_none() && !selected.is_empty() {
        return Err(Failure::thrown(format!(
            "Cannot read properties of undefined (reading '{}')",
            selected[0] - 1
        )));
    }
    let values: Vec<_> = selected
        .iter()
        .map(|i| {
            target
                .and_then(|v| column(v).get(*i))
                .cloned()
                .unwrap_or(V::Undefined)
        })
        .collect();
    let result = match name {
        "DGET" => match values.len() {
            0 => V::Error(E::Value),
            1 => values[0].clone(),
            _ => V::Error(E::Num),
        },
        "DAVERAGE" => {
            if values.is_empty() {
                V::Error(E::Div0)
            } else {
                let total = values.iter().fold(V::Number(0.0), add);
                V::Number(to_js_number(&total) / values.len() as f64)
            }
        }
        "DCOUNT" => V::Number(numbers(&values).len() as f64),
        "DCOUNTA" => V::Number(
            flatten(&values)
                .iter()
                .filter(|v| {
                    !matches!(v, V::Null | V::Undefined) && !matches!(v,V::Text(s)if s.is_empty())
                })
                .count() as f64,
        ),
        "DMAX" | "DMIN" => {
            let mut best = values.first().cloned().unwrap_or(V::Undefined);
            for v in &values {
                if if name == "DMAX" {
                    less(&best, v)
                } else {
                    less(v, &best)
                } {
                    best = v.clone()
                }
            }
            best
        }
        "DPRODUCT" => V::Number(
            values
                .iter()
                .filter(|v| is_truthy(v))
                .fold(1.0, |p, v| p * to_js_number(v)),
        ),
        "DSUM" => sum(&values),
        _ => {
            let values: Vec<_> = values
                .into_iter()
                .filter(|v| !name.starts_with("DSTDEV") || is_truthy(v))
                .collect();
            let ns = numbers(&values);
            let n = ns.len() as f64;
            let avg = ns.iter().fold(0.0, |total, x| total + x) / n;
            let variance = ns
                .iter()
                .map(|x| mixdog_js::math::pow(x - avg, 2.0))
                .fold(0.0, |total, x| total + x)
                / (n - if matches!(name, "DVAR" | "DSTDEV") {
                    1.0
                } else {
                    0.0
                });
            if matches!(name, "DVARP" | "DSTDEVP") && variance.is_nan() {
                V::Error(E::Num)
            } else {
                V::Number(if name.starts_with("DSTDEV") {
                    variance.sqrt()
                } else {
                    variance
                })
            }
        }
    };
    Ok(result)
}
