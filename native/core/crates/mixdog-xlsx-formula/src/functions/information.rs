//! formulajs 4.6.1 information functions. Error identity and nonfinite numbers
//! deliberately follow the library, including TYPE(undefined) returning undefined.
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
use crate::coerce::to_js_number;
use crate::{ErrorValue as E, Failure, Table, Value};
fn arg(a: &[Value]) -> &Value {
    a.first().unwrap_or(&Value::Undefined)
}
pub(crate) fn is_err(v: &Value) -> bool {
    matches!(
        v,
        Value::Error(E::Value | E::Ref | E::Div0 | E::Num | E::Name | E::Nil)
    ) || matches!(v, Value::Number(n) if !n.is_finite())
}
pub(crate) fn is_error(v: &Value) -> bool {
    is_err(v) || matches!(v, Value::Error(E::Na))
}
pub fn isblank(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(matches!(arg(a), Value::Null)))
}
pub fn iserr(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(is_err(arg(a))))
}
pub fn iserror(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(is_error(arg(a))))
}
fn odd(v: &Value) -> bool {
    let n = mixdog_js::math::floor(mixdog_js::math::abs(to_js_number(v)));
    n.is_finite() && n % 2.0 == 1.0
}
pub fn iseven(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(!odd(arg(a))))
}
pub fn isodd(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(odd(arg(a))))
}
pub fn islogical(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(matches!(arg(a), Value::Bool(_))))
}
pub fn isna(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(matches!(arg(a), Value::Error(E::Na))))
}
pub fn isnontext(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(!arg(a).is_text()))
}
pub fn isnumber(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(
        matches!(arg(a),Value::Number(n) if n.is_finite()),
    ))
}
pub fn istext(a: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Bool(arg(a).is_text()))
}
pub fn na(_: &[Value]) -> Result<Value, Failure> {
    Ok(Value::Error(E::Na))
}
pub fn n(a: &[Value]) -> Result<Value, Failure> {
    Ok(match arg(a) {
        Value::Number(n) if n.is_finite() => Value::Number(*n),
        Value::Date(t) => Value::Number(*t),
        Value::Bool(b) => Value::Number(if *b { 1.0 } else { 0.0 }),
        v if is_error(v) => v.clone(),
        _ => Value::Number(0.0),
    })
}
pub fn type_of(a: &[Value]) -> Result<Value, Failure> {
    let v = arg(a);
    Ok(match v {
        Value::Number(n) if n.is_finite() => Value::Number(1.0),
        Value::Text(_) | Value::Utf16(_) => Value::Number(2.0),
        Value::Bool(_) => Value::Number(4.0),
        v if is_error(v) => Value::Number(16.0),
        Value::Array(_) => Value::Number(64.0),
        _ => Value::Undefined,
    })
}
pub fn error_type(a: &[Value]) -> Result<Value, Failure> {
    Ok(match arg(a) {
        Value::Error(e) => match e {
            E::Nil => Value::Number(1.0),
            E::Div0 => Value::Number(2.0),
            E::Value => Value::Number(3.0),
            E::Ref => Value::Number(4.0),
            E::Name => Value::Number(5.0),
            E::Num => Value::Number(6.0),
            E::Na => Value::Number(7.0),
            E::Data => Value::Number(8.0),
            _ => Value::Error(E::Na),
        },
        _ => Value::Error(E::Na),
    })
}
pub const FUNCTIONS: Table = &[
    ("ERROR.TYPE", error_type),
    ("ISBLANK", isblank),
    ("ISERR", iserr),
    ("ISERROR", iserror),
    ("ISEVEN", iseven),
    ("ISLOGICAL", islogical),
    ("ISNA", isna),
    ("ISNONTEXT", isnontext),
    ("ISNUMBER", isnumber),
    ("ISODD", isodd),
    ("ISTEXT", istext),
    ("N", n),
    ("NA", na),
    ("TYPE", type_of),
];
