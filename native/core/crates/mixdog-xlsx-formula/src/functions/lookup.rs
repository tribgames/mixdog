//! Lookup/reference exports from the installed formulajs 4.6.1 (which has no XLOOKUP export).
use super::text::{arg, default};
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::js_sort_by;
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        CHOOSE, CHOOSECOLS, CHOOSEROWS, COLUMN, COLUMNS, DROP, EXPAND, HLOOKUP, HSTACK, INDEX, LOOKUP, MATCH, ROW, ROWS, SORT, TAKE, TRANSPOSE, UNIQUE,
        VLOOKUP, VSTACK
    );
}
pub use exports::FUNCTIONS;
fn index(n: f64) -> Option<usize> {
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as usize)
}
fn cell(v: &V, i: f64) -> V {
    let Some(i) = index(i) else {
        return V::Undefined;
    };
    match v {
        V::Array(v) => v.get(i).cloned().unwrap_or(V::Undefined),
        v if v.is_text() => v.text_units().unwrap().get(i).map_or(V::Undefined, |u| V::from_utf16(vec![*u])),
        _ => V::Undefined,
    }
}
fn len(v: &V) -> f64 {
    match v {
        V::Array(v) => v.len() as f64,
        V::Text(s) => s.encode_utf16().count() as f64,
        V::Utf16(units) => units.len() as f64,
        _ => f64::NAN,
    }
}
fn null_zero(v: V) -> V {
    if is_defined(&v) { v } else { V::Number(0.0) }
}
fn relational_primitive(value: &V) -> V {
    match value {
        V::Array(_) | V::Error(_) => V::from_utf16(to_js_utf16(value)),
        V::Date(time) => V::Number(*time),
        other => other.clone(),
    }
}
fn less(a: &V, b: &V) -> bool {
    match (relational_primitive(a), relational_primitive(b)) {
        (a, b) if a.is_text() && b.is_text() => a.text_units().unwrap() < b.text_units().unwrap(),
        (a, b) => to_js_number(&a) < to_js_number(&b),
    }
}
fn less_equal(a: &V, b: &V) -> bool {
    match (relational_primitive(a), relational_primitive(b)) {
        (a, b) if a.is_text() && b.is_text() => a.text_units().unwrap() <= b.text_units().unwrap(),
        (a, b) => to_js_number(&a) <= to_js_number(&b),
    }
}
fn lower(v: V) -> V {
    if let Some(units) = v.text_units() { V::from_utf16(case_utf16(&units, false)) } else { v }
}
fn locale_less(a: &V, b: &V) -> bool {
    let a = to_js_utf16(a);
    let b = to_js_utf16(b);
    mixdog_js::locale_compare_utf16(&a, &b).is_lt()
}
fn raw_match(pattern: &[u16], input: &[u16]) -> Result<bool, Failure> {
    let mut pattern = case_utf16(pattern, false);
    for (unit, replacement) in [(63, "."), (42, ".*"), (126, "\\"), (43, "\\+"), (40, "\\("), (41, "\\)"), (91, "\\["), (93, "\\]")] {
        let mut next = Vec::new();
        for u in pattern {
            if u == unit {
                next.extend(replacement.encode_utf16());
            } else {
                next.push(u);
            }
        }
        pattern = next;
    }
    pattern.insert(0, 94);
    pattern.push(36);
    mixdog_js::regex_is_match_utf16(&pattern, &case_utf16(input, false), "").map_err(Failure::thrown)
}

fn array(v: &V) -> Result<&[V], Failure> {
    if let V::Array(a) = v {
        Ok(a)
    } else {
        Err(Failure::thrown(match v {
            V::Undefined => "Cannot read properties of undefined (reading 'length')",
            V::Null => "Cannot read properties of null (reading 'length')",
            _ => "array.reduce is not a function",
        }))
    }
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let (x, y, z) = (arg(a, 0), arg(a, 1), arg(a, 2));
    let err = |e| Ok(V::Error(e));
    match name {
        "CHOOSE" => {
            if a.len() < 2 {
                return err(E::Na);
            }
            let n = to_js_number(&x);
            let add = if matches!(x, V::Text(_)) { to_js_number(&V::Text(to_js_string(&x) + "1")) } else { n + 1.0 };
            if n < 1.0 || n > 254.0 || (a.len() as f64) < add {
                return err(E::Value);
            }
            Ok(index(n).and_then(|i| a.get(i)).cloned().unwrap_or(V::Undefined))
        }
        "UNIQUE" => {
            let mut out = Vec::new();
            for v in a {
                if !out.iter().any(|known| js_strict_equals(known, v)) {
                    out.push(v.clone())
                }
            }
            Ok(V::Array(out))
        }
        "COLUMNS" | "ROWS" => {
            if a.len() != 1 {
                return err(E::Na);
            }
            let V::Array(rows) = x else {
                return err(E::Value);
            };
            let n = if rows.is_empty() {
                0
            } else if name == "ROWS" {
                rows.len()
            } else {
                let n = len(&rows[0]);
                if n.is_nan() || n == 0.0 { 1 } else { n as usize }
            };
            Ok(V::Number(n as f64))
        }
        "COLUMN" | "ROW" => {
            if a.len() != 2 {
                return err(E::Na);
            }
            if to_js_number(&y) < 0.0 {
                return err(E::Num);
            }
            let (V::Array(rows), V::Number(i)) = (x, y) else {
                return err(E::Value);
            };
            if rows.is_empty() {
                return Ok(V::Undefined);
            }
            if name == "ROW" {
                Ok(index(i).and_then(|i| rows.get(i)).cloned().unwrap_or(V::Undefined))
            } else {
                Ok(V::Array(rows.iter().map(|r| V::Array(vec![cell(r, i)])).collect()))
            }
        }
        "TRANSPOSE" => {
            if !is_truthy(&x) {
                return err(E::Na);
            }
            transpose(&fill_matrix(&x)?)
        }
        "INDEX" => {
            if let Some(e) = any_error(&[x.clone(), y.clone(), z.clone()]) {
                return err(e);
            }
            let V::Array(rows) = &x else {
                return err(E::Value);
            };
            let one = rows.first().is_some_and(|v| !matches!(v, V::Array(_)));
            let (r, c) = if one && !is_truthy(&z) {
                (V::Number(1.0), y)
            } else {
                (if is_truthy(&y) { y } else { V::Number(1.0) }, if is_truthy(&z) { z } else { V::Number(1.0) })
            };
            let (rn, cn) = (to_js_number(&r), to_js_number(&c));
            if rn < 0.0 || cn < 0.0 {
                return err(E::Value);
            }
            if one && matches!(r, V::Number(1.0)) && cn <= rows.len() as f64 {
                return Ok(cell(&x, cn - 1.0));
            }
            if rn <= rows.len() as f64 {
                let row = cell(&x, rn - 1.0);
                if matches!(row, V::Undefined | V::Null) {
                    return Err(Failure::thrown(format!("Cannot read properties of {} (reading 'length')", to_js_string(&row))));
                }
                if cn <= len(&row) {
                    return Ok(cell(&row, cn - 1.0));
                }
            }
            err(E::Ref)
        }
        "LOOKUP" => {
            let values = flatten(&[y]);
            let targets = if is_truthy(&z) { flatten(&[z]) } else { values.clone() };
            let mut result = V::Error(E::Na);
            let numeric = matches!(x, V::Number(_));
            for (i, v) in values.iter().enumerate() {
                if js_strict_equals(v, &x) {
                    return Ok(targets.get(i).cloned().unwrap_or(V::Undefined));
                } else if (numeric && less_equal(v, &x)) || (v.is_text() && locale_less(v, &x)) {
                    result = targets.get(i).cloned().unwrap_or(V::Undefined)
                } else if numeric && less(&x, v) {
                    return Ok(result);
                }
            }
            Ok(result)
        }
        "VLOOKUP" | "HLOOKUP" => {
            let table = if name == "HLOOKUP" { transpose(&y)? } else { y };
            if !is_truthy(&table) || !is_truthy(&z) {
                return err(E::Na);
            }
            let range = arg(a, 3);
            let approx = !matches!(range, V::Bool(false) | V::Number(0.0));
            let numeric = matches!(x, V::Number(_));
            let key = lower(x.clone());
            let mut result = V::Error(E::Na);
            let mut exact = false;
            let size = len(&table);
            let mut i = 0.0;
            while i < size {
                let row = cell(&table, i);
                if matches!(row, V::Null | V::Undefined) {
                    return Err(Failure::thrown(format!("Cannot read properties of {} (reading '0')", to_js_string(&row))));
                }
                let row_key = lower(cell(&row, 0.0));
                let value = || {
                    if to_js_number(&z) < len(&row) + 1.0 { cell(&row, to_js_number(&z) - 1.0) } else { V::Error(E::Ref) }
                };
                if js_strict_equals(&row_key, &key) {
                    result = value();
                    break;
                } else if !exact && approx && ((numeric && less_equal(&row_key, &x)) || (row_key.is_text() && locale_less(&row_key, &x))) {
                    result = value()
                }
                if numeric && less(&x, &row_key) {
                    exact = true
                }
                i += 1.0;
            }
            Ok(result)
        }
        "MATCH" => {
            if (!is_truthy(&x) && !matches!(x, V::Number(0.0))) || !is_truthy(&y) {
                return err(E::Na);
            }
            let kind = if a.len() == 2 { V::Number(1.0) } else { z };
            let V::Number(k) = kind else {
                return err(E::Na);
            };
            if ![-1.0, 0.0, 1.0].contains(&k) {
                return err(E::Na);
            }
            let values = flatten(&[y]);
            let mut best = V::Undefined;
            let mut found = None;
            for (i, v) in values.iter().enumerate() {
                if k == 0.0 {
                    if (x.is_text() && v.is_text()) && (matches!(x, V::Utf16(_)) || matches!(v, V::Utf16(_))) {
                        if raw_match(&x.text_units().unwrap(), &v.text_units().unwrap())? {
                            return Ok(V::Number((i + 1) as f64));
                        }
                    } else if let (V::Text(pattern), V::Text(s)) = (&x, v) {
                        let pattern = pattern
                            .to_lowercase()
                            .replace('?', ".")
                            .replace('*', ".*")
                            .replace('~', "\\")
                            .replace('+', "\\+")
                            .replace('(', "\\(")
                            .replace(')', "\\)")
                            .replace('[', "\\[")
                            .replace(']', "\\]");
                        let re = mixdog_js::JsRegex::new(&format!("^{pattern}$"), "").map_err(Failure::thrown)?;
                        if re.is_match(&s.to_lowercase()) {
                            return Ok(V::Number((i + 1) as f64));
                        }
                    } else if js_strict_equals(v, &x) {
                        return Ok(V::Number((i + 1) as f64));
                    }
                } else if js_strict_equals(v, &x) {
                    return Ok(V::Number((i + 1) as f64));
                } else if (k == 1.0 && less(v, &x) && (!is_truthy(&best) || less(&best, v)))
                    || (k == -1.0 && less(&x, v) && (!is_truthy(&best) || less(v, &best)))
                {
                    found = Some(i + 1);
                    best = v.clone()
                }
            }
            Ok(found.map_or(V::Error(E::Na), |i| V::Number(i as f64)))
        }
        "CHOOSECOLS" | "CHOOSEROWS" => {
            let V::Array(rows) = &x else {
                return err(E::Value);
            };
            let (_, columns) = get_matrix_size(rows);
            let size = if name == "CHOOSEROWS" { rows.len() } else { columns };
            let selections = flatten(if a.len() > 1 { &a[1..] } else { &[V::Undefined] });
            let mut indices = Vec::new();
            for s in selections {
                let n = to_js_number(&s);
                if !is_defined(&s) || !(n.abs() > 0.0 && n.abs() <= size as f64) {
                    return err(E::Value);
                }
                let n = if n < 0.0 {
                    if matches!(s, V::Text(_)) { to_js_number(&V::Text(format!("{}{}1", to_js_string(&s), size))) } else { n + size as f64 + 1.0 }
                } else {
                    n
                };
                indices.push(n - 1.0)
            }
            if name == "CHOOSECOLS" {
                Ok(V::Array(rows.iter().map(|r| V::Array(indices.iter().map(|i| null_zero(cell(r, *i))).collect())).collect()))
            } else {
                let mut out = Vec::new();
                for i in indices {
                    match cell(&x, i) {
                        V::Array(v) => out.push(V::Array(v.into_iter().map(null_zero).collect())),
                        v if v.is_text() => out.push(V::Array(
                            char::decode_utf16(v.text_units().unwrap())
                                .map(|c| match c {
                                    Ok(c) => V::text(c.to_string()),
                                    Err(e) => V::from_utf16(vec![e.unpaired_surrogate()]),
                                })
                                .collect(),
                        )),
                        _ => {
                            return Err(Failure::thrown("array[(--row_num_selection)] is not iterable"));
                        }
                    }
                }
                Ok(V::Array(out))
            }
        }
        "DROP" | "TAKE" => {
            if let Some(e) = any_error(&[x.clone(), y.clone(), z.clone()]) {
                return err(e);
            }
            let V::Array(rows) = &x else {
                return err(E::Value);
            };
            let (rs, cs) = get_matrix_size(rows);
            let take = name == "TAKE";
            let bounds = |n: &V, size: usize| -> Result<(f64, f64), E> {
                let size = size as f64;
                let mut b = 0.0;
                let mut e = size;
                if let V::Number(n) = n {
                    if take {
                        if *n == 0.0 {
                            return Err(E::Calc);
                        }
                        if n.abs() <= size {
                            if *n < 0.0 { b = size + n } else { e = *n }
                        }
                    } else {
                        if n.abs() > size {
                            return Err(E::Calc);
                        }
                        if *n > 0.0 {
                            b = *n
                        } else if *n < 0.0 {
                            e += n
                        }
                    }
                }
                Ok((b, e))
            };
            let (rb, re) = match bounds(&y, rs) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            let (cb, ce) = match bounds(&z, cs) {
                Ok(v) => v,
                Err(e) => return err(e),
            };
            if take && (re - rb <= 0.0 || ce - cb <= 0.0) {
                return err(E::Value);
            }
            let mut out = Vec::new();
            let mut r = rb;
            while r < re {
                let row = cell(&x, r);
                if !take && !matches!(row, V::Array(_)) {
                    return Err(Failure::thrown(if matches!(row, V::Undefined) {
                        "Cannot read properties of undefined (reading 'slice')"
                    } else {
                        "array[iRow].slice is not a function"
                    }));
                }
                let mut cells = Vec::new();
                let mut c = cb;
                if take {
                    while c < ce {
                        cells.push(null_zero(cell(&row, c)));
                        c += 1.0
                    }
                } else if let V::Array(values) = row {
                    let start = cb.max(0.0).min(values.len() as f64) as usize;
                    let end = ce.max(0.0).min(values.len() as f64) as usize;
                    cells.extend(values[start.min(end)..end].iter().cloned().map(null_zero))
                }
                out.push(V::Array(cells));
                r += 1.0
            }
            Ok(V::Array(out))
        }
        "EXPAND" => {
            let rows = array(&x)?;
            let (rs, cs) = get_matrix_size(rows);
            let r = if is_defined(&y) { y } else { V::Number(rs as f64) };
            let c = if is_defined(&z) { z } else { V::Number(cs as f64) };
            if to_js_number(&r) < rs as f64 || to_js_number(&c) < cs as f64 {
                return err(E::Value);
            }
            let result = create_matrix(&r, &c)?;
            let V::Array(mut matrix) = result else {
                return Ok(result);
            };
            let pad = arg(a, 3);
            for (i, row) in matrix.iter_mut().enumerate() {
                if let V::Array(v) = row {
                    for (j, dst) in v.iter_mut().enumerate() {
                        let value = cell(&cell(&x, i as f64), j as f64);
                        *dst = if is_defined(&value) {
                            value
                        } else if i < rs && j < cs {
                            V::Number(0.0)
                        } else if is_defined(&pad) {
                            pad.clone()
                        } else {
                            V::Error(E::Na)
                        }
                    }
                }
            }
            Ok(V::Array(matrix))
        }
        "HSTACK" | "VSTACK" => {
            let values = if a.is_empty() { vec![V::Undefined] } else { a.to_vec() };
            let mut dimensions = Vec::new();
            for v in &values {
                dimensions.push(get_matrix_size(array(v)?))
            }
            let horizontal = name == "HSTACK";
            let nr = if horizontal { dimensions.iter().map(|d| d.0).max().unwrap_or(0) } else { dimensions.iter().map(|d| d.0).sum() };
            let nc = if horizontal { dimensions.iter().map(|d| d.1).sum() } else { dimensions.iter().map(|d| d.1).max().unwrap_or(0) };
            let mut out = vec![vec![V::Undefined; nc]; nr];
            let mut offset = 0;
            for (v, (rs, cs)) in values.iter().zip(dimensions) {
                if horizontal {
                    for c in 0..cs {
                        for (r, out) in out.iter_mut().enumerate() {
                            let value = cell(&cell(v, r as f64), c as f64);
                            out[offset + c] = if is_defined(&value) {
                                value
                            } else if r < rs {
                                V::Number(0.0)
                            } else {
                                V::Error(E::Na)
                            }
                        }
                    }
                    offset += cs
                } else {
                    for r in 0..rs {
                        let row = cell(v, r as f64);
                        for (c, slot) in out[offset + r].iter_mut().enumerate().take(nc) {
                            let value = cell(&row, c as f64);
                            *slot = if is_defined(&value) {
                                value
                            } else if (c as f64) < len(&row) {
                                V::Number(0.0)
                            } else {
                                V::Error(E::Na)
                            }
                        }
                    }
                    offset += rs
                }
            }
            Ok(V::Array(out.into_iter().map(V::Array).collect()))
        }
        "SORT" => {
            let V::Array(rows) = &x else {
                return err(E::Na);
            };
            if rows.is_empty() {
                return Ok(V::Number(0.0));
            }
            let sort_index = parse_number(&default(a, 1, V::Number(1.0)));
            let i = to_js_number(&sort_index);
            if !is_truthy(&sort_index) || i < 1.0 {
                return err(E::Value);
            }
            let order = parse_number(&default(a, 2, V::Number(1.0)));
            let V::Number(order) = order else {
                return err(E::Value);
            };
            if order != 1.0 && order != -1.0 {
                return err(E::Value);
            }
            let col = parse_bool(&default(a, 3, V::Bool(false)));
            let V::Bool(col) = col else {
                return err(E::Name);
            };
            let matrix = fill_matrix(&x)?;
            let matrix = if col { transpose(&matrix)? } else { matrix };
            let V::Array(mut rows) = matrix else {
                return Ok(matrix);
            };
            if !(i >= 1.0 && rows.first().is_some_and(|r| i <= len(r))) {
                return err(E::Value);
            }
            // The source returns +1 for equal/incomparable keys, never 0.
            // Preserve that comparator and V8's comparison order (including ties)
            // instead of requiring Rust sort's strict weak ordering.
            js_sort_by(&mut rows, |a, b| {
                let a = parse_string(&cell(a, i - 1.0));
                let b = parse_string(&cell(b, i - 1.0));
                let before = if order == 1.0 { less(&a, &b) } else { less(&b, &a) };
                if before { -1.0 } else { 1.0 }
            });
            if col { transpose(&V::Array(rows)) } else { Ok(V::Array(rows)) }
        }
        _ => unreachable!(),
    }
}
