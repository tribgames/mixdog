//! formulajs 4.6.1 logical functions, including eager argument/error conventions.
/* Ported from formulajs 4.6.1.
Copyright (c) 2014 Sutoiku, Inc.

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
use super::information::is_error;
use crate::coerce::{flatten, is_truthy, js_strict_equals};
use crate::{ErrorValue as E, Failure, Table, Value};
fn arg(a: &[Value], i: usize) -> Value {
    a.get(i).cloned().unwrap_or(Value::Undefined)
}
fn fold(a: &[Value], kind: u8) -> Value {
    let mut count = 0usize;
    let mut true_count = 0usize;
    for v in flatten(a) {
        match v {
            Value::Error(_) => return v,
            Value::Null | Value::Undefined | Value::Text(_) | Value::Utf16(_) => continue,
            _ => {}
        }
        count += 1;
        if is_truthy(&v) {
            true_count += 1;
        }
    }
    if count == 0 {
        Value::Error(E::Value)
    } else {
        Value::Bool(match kind {
            0 => true_count == count,
            1 => true_count > 0,
            _ => true_count % 2 == 1,
        })
    }
}
pub fn and(a: &[Value]) -> Result<Value, Failure> {
    Ok(fold(a, 0))
}
pub fn or(a: &[Value]) -> Result<Value, Failure> {
    Ok(fold(a, 1))
}
pub fn xor(a: &[Value]) -> Result<Value, Failure> {
    Ok(fold(a, 2))
}
pub fn false_value(_: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(false))
}
pub fn true_value(_: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(true))
}
pub fn if_value(a: &[Value]) -> Result<Value, Failure> {
    let test = arg(a, 0);
    if matches!(test, Value::Error(_)) {
        return Ok(test);
    }
    let blank = |v| {
        if matches!(v, Value::Null | Value::Undefined) { Value::Number(0.0) } else { v }
    };
    let yes = blank(if a.len() >= 2 { arg(a, 1) } else { Value::Bool(true) });
    let no = blank(if a.len() == 3 { arg(a, 2) } else { Value::Bool(false) });
    Ok(if is_truthy(&test) { yes } else { no })
}
pub fn ifs(a: &[Value]) -> Result<Value, Failure> {
    for pair in a.chunks(2) {
        if is_truthy(&pair[0]) {
            return Ok(arg(pair, 1));
        }
    }
    Ok(Value::Error(E::Na))
}
pub fn iferror(a: &[Value]) -> Result<Value, Failure> {
    let v = arg(a, 0);
    Ok(if is_error(&v) { arg(a, 1) } else { v })
}
pub fn ifna(a: &[Value]) -> Result<Value, Failure> {
    let v = arg(a, 0);
    Ok(if matches!(v, Value::Error(E::Na)) { arg(a, 1) } else { v })
}
pub fn not(a: &[Value]) -> Result<Value, Failure> {
    let v = arg(a, 0);
    Ok(match v {
        Value::Text(_) | Value::Utf16(_) => Value::Error(E::Value),
        Value::Error(_) => v,
        _ => Value::Bool(!is_truthy(&v)),
    })
}
pub fn switch(a: &[Value]) -> Result<Value, Failure> {
    let Some(target) = a.first() else {
        return Ok(Value::Error(E::Value));
    };
    for pair in a[1..].as_chunks::<2>().0 {
        if js_strict_equals(target, &pair[0]) {
            return Ok(pair[1].clone());
        }
    }
    Ok(if !(a.len() - 1).is_multiple_of(2) { a.last().unwrap().clone() } else { Value::Error(E::Na) })
}
pub const FUNCTIONS: Table = &[
    ("AND", and),
    ("FALSE", false_value),
    ("IF", if_value),
    ("IFS", ifs),
    ("IFERROR", iferror),
    ("IFNA", ifna),
    ("NOT", not),
    ("OR", or),
    ("TRUE", true_value),
    ("XOR", xor),
    ("SWITCH", switch),
];
