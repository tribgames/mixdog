//! Math/trigonometry exports of formulajs 4.6.1, including its historical quirks.
//! Shared V8 primitives and statistical registrations are integration dependencies
//! specified in nr-office-formula-lib-math.wire; no platform-libm substitute is used.
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
use crate::coerce::{
    apply_criteria, array_values_to_numbers, flatten, is_truthy, meets_criteria, parse_float,
    parse_number, parse_number_array, to_js_number, to_js_string,
};
use crate::{ErrorValue as E, Failure, Table, Value};
use mixdog_js::{math as j, number_to_string, string_to_number};
use std::cell::Cell;
fn arg(a: &[Value], i: usize) -> Value {
    a.get(i).cloned().unwrap_or(Value::Undefined)
}
fn parsed(a: &[Value], n: usize) -> Result<Vec<f64>, E> {
    (0..n)
        .map(|i| match parse_number(&arg(a, i)) {
            Value::Number(n) => Ok(n),
            Value::Error(e) => Err(e),
            _ => unreachable!(),
        })
        .collect()
}
fn array_numbers(a: &[Value]) -> Result<Vec<f64>, E> {
    parse_number_array(a).map(|v| v.iter().map(to_js_number).collect())
}
fn err(e: E) -> Result<Value, Failure> {
    Ok(Value::Error(e))
}
fn num(n: f64) -> Result<Value, Failure> {
    Ok(Value::Number(n))
}
fn nan_num(n: f64) -> Result<Value, Failure> {
    if n.is_nan() { err(E::Num) } else { num(n) }
}
macro_rules! unary {
    ($name:ident,$x:ident,$body:expr) => {
        pub fn $name(a: &[Value]) -> Result<Value, Failure> {
            let p = match parsed(a, 1) {
                Ok(p) => p,
                Err(e) => return err(e),
            };
            let $x = p[0];
            $body
        }
    };
}
macro_rules! binary {
    ($name:ident,$x:ident,$y:ident,$body:expr) => {
        pub fn $name(a: &[Value]) -> Result<Value, Failure> {
            let p = match parsed(a, 2) {
                Ok(p) => p,
                Err(e) => return err(e),
            };
            let ($x, $y) = (p[0], p[1]);
            $body
        }
    };
}
unary!(abs, x, num(j::abs(x)));
unary!(acos, x, nan_num(j::acos(x)));
unary!(acosh, x, nan_num(j::ln(x + j::sqrt(x * x - 1.0))));
unary!(acot, x, num(j::atan(1.0 / x)));
unary!(acoth, x, nan_num(0.5 * j::ln((x + 1.0) / (x - 1.0))));
unary!(asin, x, nan_num(j::asin(x)));
unary!(asinh, x, num(j::ln(x + j::sqrt(x * x + 1.0))));
unary!(atan, x, num(j::atan(x)));
binary!(atan2, x, y, num(j::atan2(x, y)));
unary!(atanh, x, nan_num(j::ln((1.0 + x) / (1.0 - x)) / 2.0));
unary!(cos, x, num(j::cos(x)));
unary!(cosh, x, num((j::exp(x) + j::exp(-x)) / 2.0));
unary!(
    cot,
    x,
    if x == 0.0 {
        err(E::Div0)
    } else {
        num(1.0 / j::tan(x))
    }
);
unary!(
    coth,
    x,
    if x == 0.0 {
        err(E::Div0)
    } else {
        let e = j::exp(2.0 * x);
        num((e + 1.0) / (e - 1.0))
    }
);
unary!(
    csc,
    x,
    if x == 0.0 {
        err(E::Div0)
    } else {
        num(1.0 / j::sin(x))
    }
);
unary!(
    csch,
    x,
    if x == 0.0 {
        err(E::Div0)
    } else {
        num(2.0 / (j::exp(x) - j::exp(-x)))
    }
);
unary!(degrees, x, num((x * 180.0) / std::f64::consts::PI));
unary!(int, x, num(j::floor(x)));
unary!(ln, x, if x == 0.0 { err(E::Num) } else { num(j::ln(x)) });
unary!(
    log10,
    x,
    if x == 0.0 {
        err(E::Num)
    } else {
        num(j::ln(x) / j::ln(10.0))
    }
);
unary!(radians, x, num((x * std::f64::consts::PI) / 180.0));
unary!(sec, x, num(1.0 / j::cos(x)));
unary!(sech, x, num(2.0 / (j::exp(x) + j::exp(-x))));
unary!(
    sign,
    x,
    num(if x < 0.0 {
        -1.0
    } else if x == 0.0 {
        0.0
    } else {
        1.0
    })
);
unary!(sin, x, num(j::sin(x)));
unary!(sinh, x, num((j::exp(x) - j::exp(-x)) / 2.0));
unary!(
    sqrt,
    x,
    if x < 0.0 {
        err(E::Num)
    } else {
        num(j::sqrt(x))
    }
);
unary!(sqrtpi, x, num(j::sqrt(x * std::f64::consts::PI)));
unary!(tan, x, num(j::tan(x)));
unary!(tanh, x, {
    let e = j::exp(2.0 * x);
    num((e - 1.0) / (e + 1.0))
});
binary!(
    ceiling,
    x,
    s,
    if s == 0.0 {
        num(0.0)
    } else if x > 0.0 && s < 0.0 {
        err(E::Num)
    } else {
        num(j::ceil(x / s) * s)
    }
);
binary!(
    floor,
    x,
    s,
    if s == 0.0 || s.is_nan() {
        err(E::Div0)
    } else if x > 0.0 && s < 0.0 {
        err(E::Num)
    } else {
        num(j::floor(x / s) * s)
    }
);
binary!(
    modulo,
    x,
    d,
    if d == 0.0 {
        err(E::Div0)
    } else {
        let m = j::abs(x % d);
        let m = if x < 0.0 { d - m } else { m };
        num(if d > 0.0 { m } else { -m })
    }
);
binary!(
    mround,
    x,
    m,
    if x * m == 0.0 {
        num(0.0)
    } else if x * m < 0.0 {
        err(E::Num)
    } else {
        num(j::round(x / m) * m)
    }
);
binary!(
    power,
    x,
    p,
    if x == 0.0 && p == 0.0 {
        err(E::Num)
    } else {
        nan_num(j::pow(x, p))
    }
);
binary!(
    quotient,
    x,
    y,
    num(mixdog_js::parse_int_radix(&number_to_string(x / y), 10.0))
);
binary!(trunc, x, d, {
    let sign = if x > 0.0 { 1.0 } else { -1.0 };
    num((sign * j::floor(j::abs(x) * j::pow(10.0, d))) / j::pow(10.0, d))
});
pub fn pi(_: &[Value]) -> Result<Value, Failure> {
    num(std::f64::consts::PI)
}
pub fn exp(a: &[Value]) -> Result<Value, Failure> {
    if a.is_empty() {
        return err(E::Na);
    }
    if a.len() > 1 {
        return err(E::Error);
    }
    let p = match parsed(a, 1) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    num(j::exp(p[0]))
}
pub fn log(a: &[Value]) -> Result<Value, Failure> {
    let mut a = vec![arg(a, 0), arg(a, 1)];
    if !is_truthy(&a[1]) {
        a[1] = Value::Number(10.0)
    }
    let p = match parsed(&a, 2) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if p[0] == 0.0 || p[1] == 0.0 {
        err(E::Num)
    } else {
        num(j::ln(p[0]) / j::ln(p[1]))
    }
}
fn ceil_floor_math(a: &[Value], ceil: bool) -> Result<Value, Failure> {
    let x = arg(a, 0);
    let mut s = arg(a, 1);
    let mut mode = arg(a, 2);
    if matches!(s, Value::Undefined) {
        s = Value::Number(if ceil && to_js_number(&x) <= 0.0 {
            -1.0
        } else {
            1.0
        })
    }
    if matches!(mode, Value::Undefined) {
        mode = Value::Number(0.0)
    }
    let p = match parsed(&[x, s, mode], 3) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let (x, s, m) = (p[0], j::abs(p[1]), p[2]);
    if s == 0.0 {
        return num(0.0);
    }
    let up = if m == 0.0 || x > 0.0 { ceil } else { !ceil };
    num((if up { j::ceil(x / s) } else { j::floor(x / s) }) * s)
}
pub fn ceiling_math(a: &[Value]) -> Result<Value, Failure> {
    ceil_floor_math(a, true)
}
pub fn ceiling_precise(a: &[Value]) -> Result<Value, Failure> {
    ceil_floor_math(&[arg(a, 0), arg(a, 1)], true)
}
pub fn floor_math(a: &[Value]) -> Result<Value, Failure> {
    ceil_floor_math(a, false)
}
pub fn floor_precise(a: &[Value]) -> Result<Value, Failure> {
    ceil_floor_math(&[arg(a, 0), arg(a, 1)], false)
}
unary!(
    even,
    x,
    ceiling_math(&[Value::Number(x), Value::Number(-2.0), Value::Number(-1.0)])
);
unary!(odd, x, {
    let mut t = j::ceil(j::abs(x));
    if !(t.is_finite() && t % 2.0 == 1.0) {
        t += 1.0
    }
    num(if x >= 0.0 { t } else { -t })
});
fn factorial(x: f64) -> Result<f64, Failure> {
    let n = j::floor(x);
    if n.is_nan() {
        return Ok(f64::NAN);
    }
    if n < 0.0 || !n.is_finite() {
        return Err(Failure::thrown("Maximum call stack size exceeded"));
    }
    // Multiplication overflows at 171; further positive factors keep infinity.
    let mut v = 1.0;
    for i in 2..=(n.min(171.0) as u32) {
        v *= f64::from(i)
    }
    Ok(v)
}
unary!(fact, x, num(factorial(x)?));
unary!(factdouble, x, {
    let n = j::floor(x);
    if n.is_nan() {
        return num(f64::NAN);
    }
    if n == f64::INFINITY {
        return Err(Failure::thrown("Maximum call stack size exceeded"));
    }
    if n <= 0.0 {
        return num(1.0);
    }
    // The original recursively multiplies upward by two, preserving operation order.
    let mut v = 1.0;
    let mut i = if n % 2.0 == 0.0 { 2.0 } else { 1.0 };
    while i <= n {
        v *= i;
        if v.is_infinite() {
            break;
        }
        i += 2.0
    }
    num(v)
});
binary!(
    combin,
    n,
    k,
    if n < k {
        err(E::Num)
    } else {
        num(factorial(n)? / (factorial(k)? * factorial(n - k)?))
    }
);
binary!(
    combina,
    n,
    k,
    if n < k {
        err(E::Num)
    } else if n == 0.0 && k == 0.0 {
        num(1.0)
    } else {
        combin(&[Value::Number(n + k - 1.0), Value::Number(n - 1.0)])
    }
);
fn rounding(a: &[Value], mode: u8) -> Result<Value, Failure> {
    let p = match parsed(a, 2) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let (n, d) = (p[0], p[1]);
    let sign = if n >= 0.0 { 1.0 } else { -1.0 };
    let shift = |x: f64, exp: f64| {
        let text = format!("{}e{}", number_to_string(x), number_to_string(exp));
        let mut parts = text.split('e');
        string_to_number(&format!(
            "{}e{}",
            parts.next().unwrap(),
            parts.next().unwrap()
        ))
    };
    let shifted = shift(j::abs(n), d);
    let shifted = match mode {
        0 => j::round(shifted),
        1 => j::floor(shifted),
        _ => j::ceil(shifted),
    };
    num(shift(shifted, -d) * sign)
}
pub fn round(a: &[Value]) -> Result<Value, Failure> {
    rounding(a, 0)
}
pub fn rounddown(a: &[Value]) -> Result<Value, Failure> {
    rounding(a, 1)
}
pub fn roundup(a: &[Value]) -> Result<Value, Failure> {
    rounding(a, 2)
}
thread_local! {static RANDOM_SAMPLE:Cell<Option<f64>>=const{Cell::new(None)};}
/// A scoped deterministic source for the Node twin, restored even during unwinding.
pub fn with_random_sample<T>(sample: f64, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<f64>);
    impl Drop for Restore {
        fn drop(&mut self) {
            RANDOM_SAMPLE.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(RANDOM_SAMPLE.with(|c| c.replace(Some(sample))));
    run()
}
fn random() -> f64 {
    RANDOM_SAMPLE.with(|c| c.get()).unwrap_or_else(j::random)
}
pub fn rand(_: &[Value]) -> Result<Value, Failure> {
    num(random())
}
binary!(
    randbetween,
    b,
    t,
    num(b + j::ceil((t - b + 1.0) * random()) - 1.0)
);
pub fn base(a: &[Value]) -> Result<Value, Failure> {
    let p = match parsed(a, 3) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    if p[1] == 0.0 {
        return err(E::Num);
    }
    let result = mixdog_js::number_to_radix(p[0], p[1]).map_err(Failure::thrown)?;
    let len = j::max(p[2] + 1.0 - result.len() as f64, 0.0);
    let zeros = array_length(len)?;
    Ok(Value::Text(format!(
        "{}{}",
        repeat_text("0", zeros.saturating_sub(1))?,
        result
    )))
}
fn array_length(n: f64) -> Result<usize, Failure> {
    if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > f64::from(u32::MAX) {
        Err(Failure::thrown("Invalid array length"))
    } else {
        Ok(n as usize)
    }
}
fn repeat_text(text: &str, n: usize) -> Result<String, Failure> {
    let size = text
        .len()
        .checked_mul(n)
        .ok_or_else(|| Failure::thrown("Invalid string length"))?;
    // V8's 64-bit string length limit (the original packaged Node/Electron).
    if size > (1usize << 29) - 24 {
        return Err(Failure::thrown("Invalid string length"));
    }
    let mut out = String::new();
    out.try_reserve_exact(size)
        .map_err(|_| Failure::thrown("Invalid string length"))?;
    for _ in 0..n {
        out.push_str(text)
    }
    Ok(out)
}
pub fn decimal(a: &[Value]) -> Result<Value, Failure> {
    if a.len() < 2 {
        return err(E::Na);
    }
    let mut text = arg(a, 0);
    if !is_truthy(&text) {
        text = Value::text("0")
    };
    let radix = parse_number(&arg(a, 1));
    if let Value::Error(e) = text {
        return err(e);
    }
    if let Value::Error(e) = radix {
        return err(e);
    }
    let r = to_js_number(&radix);
    if r == 0.0 {
        return err(E::Num);
    }
    nan_num(mixdog_js::parse_int_radix(&to_js_string(&text), r))
}
pub fn arabic(a: &[Value]) -> Result<Value, Failure> {
    let v = arg(a, 0);
    if matches!(v, Value::Undefined | Value::Null) {
        return num(0.0);
    }
    if let Value::Error(e) = v {
        return err(e);
    }
    let text = to_js_string(&v);
    let pattern = mixdog_js::JsRegex::new_static(
        r"^M*(?:D?C{0,3}|C[MD])(?:L?X{0,3}|X[CL])(?:V?I{0,3}|I[XV])$",
        "",
    );
    if !pattern.is_match(&text) {
        return err(E::Value);
    }
    if !matches!(v, Value::Text(_)) {
        return Err(Failure::thrown("text.replace is not a function"));
    }
    let values = |b: u8| match b {
        b'M' => 1000,
        b'D' => 500,
        b'C' => 100,
        b'L' => 50,
        b'X' => 10,
        b'V' => 5,
        b'I' => 1,
        _ => 0,
    };
    let bytes = text.as_bytes();
    let mut total = 0i64;
    for (i, &b) in bytes.iter().enumerate() {
        let n = values(b);
        total += if bytes.get(i + 1).is_some_and(|next| values(*next) > n) {
            -n
        } else {
            n
        };
    }
    num(total as f64)
}
// Original Roman algorithm: Copyright (c) 2008 Steven Levithan, MIT.
pub fn roman(a: &[Value]) -> Result<Value, Failure> {
    let p = match parsed(a, 1) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut digits: Vec<char> = number_to_string(p[0]).chars().collect();
    const KEY: [&str; 30] = [
        "", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM", "", "X", "XX", "XXX", "XL",
        "L", "LX", "LXX", "LXXX", "XC", "", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX",
    ];
    let mut result = String::new();
    for i in (0..3).rev() {
        let key = digits
            .pop()
            .and_then(|c| c.to_digit(10))
            .map(|d| d as usize + i * 10);
        if let Some(t) = key.and_then(|k| KEY.get(k)) {
            result = format!("{t}{result}")
        }
    }
    let prefix: String = digits.iter().collect();
    let n = array_length(string_to_number(&prefix) + 1.0)?;
    Ok(Value::Text(format!(
        "{}{}",
        repeat_text("M", n.saturating_sub(1))?,
        result
    )))
}

pub fn gcd(a: &[Value]) -> Result<Value, Failure> {
    let p = match array_numbers(&flatten(a)) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let truthy = |n: f64| n != 0.0 && !n.is_nan();
    let mut x = if p[0] < 0.0 { -p[0] } else { p[0] };
    for ri in p.iter().skip(1) {
        let mut y = if *ri < 0.0 { -*ri } else { *ri };
        while truthy(x) && truthy(y) {
            if x > y { x %= y } else { y %= x }
        }
        x += y
    }
    num(x)
}
pub fn lcm(a: &[Value]) -> Result<Value, Failure> {
    let mut o = match array_numbers(&flatten(a)) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut r = 1.0;
    while let Some(mut n) = o.pop() {
        if n == 0.0 {
            return num(0.0);
        }
        while n > 1.0 {
            let d = if n % 2.0 != 0.0 && !(n % 2.0).is_nan() {
                let mut i = 3.0;
                let max = j::floor(j::sqrt(n));
                while i <= max && n % i != 0.0 {
                    i += 2.0
                }
                if i <= max { i } else { n }
            } else {
                2.0
            };
            n /= d;
            r *= d;
            for i in (0..o.len()).rev() {
                if o[i] % d == 0.0 {
                    o[i] /= d;
                    if o[i] == 1.0 {
                        o.remove(i);
                    }
                }
            }
        }
    }
    num(r)
}
pub fn multinomial(a: &[Value]) -> Result<Value, Failure> {
    let p = match array_numbers(&flatten(a)) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut sum = 0.0;
    let mut divisor = 1.0;
    for n in p {
        sum += n;
        divisor *= factorial(n)?
    }
    num(factorial(sum)? / divisor)
}
pub fn product(a: &[Value]) -> Result<Value, Failure> {
    let vals: Vec<_> = flatten(a)
        .into_iter()
        .filter(|v| !matches!(v, Value::Undefined | Value::Null))
        .collect();
    if vals.is_empty() {
        return num(0.0);
    }
    let p = match array_numbers(&vals) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut v = 1.0;
    for n in p {
        v *= n
    }
    num(v)
}
/// Preserve SUM's nested-array subtotal order (flattening changes floating bits).
pub fn sum(a: &[Value]) -> Result<Value, Failure> {
    let mut stack = vec![(a.iter(), 0.0)];
    loop {
        let Some((items, total)) = stack.last_mut() else {
            unreachable!()
        };
        match items.next() {
            Some(Value::Error(e)) => return err(*e),
            Some(Value::Number(n)) => *total += n,
            Some(Value::Text(s)) => {
                let n = parse_float(s);
                if !n.is_nan() {
                    *total += n
                }
            }
            Some(Value::Array(v)) => stack.push((v.iter(), 0.0)),
            Some(_) => {}
            None => {
                let (_, n) = stack.pop().unwrap();
                if let Some((_, parent)) = stack.last_mut() {
                    *parent += n
                } else {
                    return num(n);
                }
            }
        }
    }
}
fn primitive(v: Value) -> Value {
    match v {
        Value::Array(_) | Value::Date(_) | Value::Error(_) => Value::Text(to_js_string(&v)),
        _ => v,
    }
}
fn add(a: Value, b: Value) -> Value {
    let a = primitive(a);
    let b = primitive(b);
    if matches!(a, Value::Text(_)) || matches!(b, Value::Text(_)) {
        Value::Text(format!("{}{}", to_js_string(&a), to_js_string(&b)))
    } else {
        Value::Number(to_js_number(&a) + to_js_number(&b))
    }
}
pub fn sumif(a: &[Value]) -> Result<Value, Failure> {
    let range = flatten(&[arg(a, 0)]);
    let criteria = arg(a, 1);
    let sum_range = if is_truthy(&arg(a, 2)) {
        flatten(&[arg(a, 2)])
    } else {
        range.clone()
    };
    if matches!(criteria, Value::Undefined | Value::Null | Value::Error(_)) {
        return num(0.0);
    }
    let wildcard = matches!(&criteria,Value::Text(s)if s=="*");
    let mut result = Value::Number(0.0);
    for (i, v) in range.iter().enumerate() {
        let term = if wildcard {
            v.clone()
        } else if meets_criteria(v, &criteria) {
            arg(&sum_range, i)
        } else {
            Value::Number(0.0)
        };
        result = add(result, term)
    }
    Ok(result)
}
pub fn sumifs(a: &[Value]) -> Result<Value, Failure> {
    let mut args = a.to_vec();
    let mut range = flatten(&[arg(a, 0)]);
    array_values_to_numbers(&mut range);
    if args.is_empty() {
        args.push(Value::Array(range))
    } else {
        args[0] = Value::Array(range)
    }
    match apply_criteria(&args) {
        Ok(v) => sum(&v),
        Err(e) => err(e),
    }
}
fn length(v: &Value) -> Result<Option<usize>, Failure> {
    match v {
        Value::Null => Err(Failure::thrown(
            "Cannot read properties of null (reading 'length')",
        )),
        Value::Undefined => Err(Failure::thrown(
            "Cannot read properties of undefined (reading 'length')",
        )),
        Value::Array(v) => Ok(Some(v.len())),
        Value::Text(s) => Ok(Some(s.encode_utf16().count())),
        _ => Ok(None),
    }
}
fn index(v: &Value, i: usize) -> Result<Value, Failure> {
    match v {
        Value::Null => Err(Failure::thrown(format!(
            "Cannot read properties of null (reading '{i}')"
        ))),
        Value::Undefined => Err(Failure::thrown(format!(
            "Cannot read properties of undefined (reading '{i}')"
        ))),
        Value::Array(v) => Ok(arg(v, i)),
        Value::Text(s) => Ok(s.encode_utf16().nth(i).map_or(Value::Undefined, |c| {
            Value::text(String::from_utf16_lossy(&[c]))
        })),
        _ => Ok(Value::Undefined),
    }
}
pub fn sumproduct(a: &[Value]) -> Result<Value, Failure> {
    if a.is_empty() {
        return err(E::Value);
    }
    let mut result = 0.0;
    let first = &a[0];
    for i in 0..length(first)?.unwrap_or(0) {
        let row = index(first, i)?;
        let columns = if matches!(row, Value::Array(_)) {
            Some(length(&row)?.unwrap_or(0))
        } else {
            None
        };
        for col in 0..columns.unwrap_or(1) {
            let mut product = 1.0;
            for v in a {
                let item = index(v, i)?;
                let item = if columns.is_some() {
                    index(&item, col)?
                } else {
                    item
                };
                match parse_number(&item) {
                    Value::Number(n) => product *= n,
                    Value::Error(e) => return err(e),
                    _ => unreachable!(),
                }
            }
            result += product
        }
    }
    num(result)
}
pub fn sumsq(a: &[Value]) -> Result<Value, Failure> {
    let p = match array_numbers(&flatten(a)) {
        Ok(p) => p,
        Err(e) => return err(e),
    };
    let mut n = 0.0;
    for x in p {
        if x.is_finite() {
            n += x * x
        }
    }
    num(n)
}
fn sumx(a: &[Value], mode: u8) -> Result<Value, Failure> {
    let mut x = match array_numbers(&flatten(&[arg(a, 0)])) {
        Ok(p) => p,
        Err(_) => return err(E::Value),
    };
    let mut y = match array_numbers(&flatten(&[arg(a, 1)])) {
        Ok(p) => p,
        Err(_) => return err(E::Value),
    };
    // The library does not check errors after the second parse: an error
    // in x has no length (zero iterations), one in y contributes undefined.
    if mode == 1 {
        let vals = |p: Vec<f64>| p.into_iter().map(Value::Number).collect::<Vec<_>>();
        x = match array_numbers(&vals(x)) {
            Ok(p) => p,
            Err(_) => return num(0.0),
        };
        y = array_numbers(&vals(y)).unwrap_or_default();
    }
    let mut n = 0.0;
    for (i, x) in x.iter().enumerate() {
        let y = y.get(i).copied().unwrap_or(f64::NAN);
        n += match mode {
            0 => x * x - y * y,
            1 => x * x + y * y,
            _ => j::pow(x - y, 2.0),
        }
    }
    num(n)
}
pub fn sumx2my2(a: &[Value]) -> Result<Value, Failure> {
    sumx(a, 0)
}
pub fn sumx2py2(a: &[Value]) -> Result<Value, Failure> {
    sumx(a, 1)
}
pub fn sumxmy2(a: &[Value]) -> Result<Value, Failure> {
    sumx(a, 2)
}
pub fn seriessum(a: &[Value]) -> Result<Value, Failure> {
    let p = match parsed(a, 3) {
        Ok(p) => p,
        Err(_) => return err(E::Value),
    };
    let coeff = arg(a, 3);
    let coeff = match coeff {
        Value::Array(v) => match parse_number_array(&v) {
            Ok(v) => Value::Array(v),
            Err(_) => return err(E::Value),
        },
        Value::Text(s) if !s.is_empty() => {
            let i = s.encode_utf16().count() - 1;
            let c = index(&Value::Text(s.clone()), i)?;
            if matches!(parse_number(&c), Value::Error(_)) {
                return err(E::Value);
            }
            return Err(Failure::thrown(format!(
                "Cannot assign to read only property '{i}' of string '{s}'"
            )));
        }
        ref v if !is_truthy(v) || matches!(v, Value::Error(_)) => return err(E::Value),
        v => v,
    };
    let mut result = to_js_number(&index(&coeff, 0)?) * j::pow(p[0], p[1]);
    for i in 1..length(&coeff)?.unwrap_or(0) {
        result += to_js_number(&index(&coeff, i)?) * j::pow(p[0], p[1] + i as f64 * p[2])
    }
    num(result)
}
pub fn munit(a: &[Value]) -> Result<Value, Failure> {
    if a.len() > 1 {
        return err(E::Na);
    }
    let n = mixdog_js::parse_int_radix(&to_js_string(&arg(a, 0)), 0.0);
    if n.is_nan() || n <= 0.0 {
        return err(E::Value);
    }
    let n = array_length(n)?;
    let mut rows = Vec::new();
    rows.try_reserve_exact(n)
        .map_err(|_| Failure::thrown("Invalid array length"))?;
    for i in 0..n {
        let mut row = Vec::new();
        row.try_reserve_exact(n)
            .map_err(|_| Failure::thrown("Invalid array length"))?;
        row.resize(n, Value::Number(0.0));
        row[i] = Value::Number(1.0);
        rows.push(Value::Array(row))
    }
    Ok(Value::Array(rows))
}
pub fn mmult(a: &[Value]) -> Result<Value, Failure> {
    let x = arg(a, 0);
    let y = arg(a, 1);
    let (Value::Array(x), Value::Array(y)) = (&x, &y) else {
        return err(E::Value);
    };
    for rows in [x, y] {
        for row in rows {
            if length(row)?.unwrap_or(0) == 0 {
                return err(E::Value);
            }
        }
    }
    for rows in [x, y] {
        if rows.is_empty() {
            return Err(Failure::thrown(
                "Reduce of empty array with no initial value",
            ));
        }
        if rows.len() == 1 && !matches!(rows[0], Value::Array(_)) {
            return Err(Failure::thrown(
                "flattenShallow(...).some is not a function",
            ));
        }
        for row in rows {
            let Value::Array(items) = row else {
                return err(E::Value);
            };
            if items.iter().any(|v| !matches!(v, Value::Number(_))) {
                return err(E::Value);
            }
        }
    }
    let width = length(&arg(x, 0))?.unwrap_or(0);
    if width != y.len() {
        return err(E::Value);
    }
    let columns = length(&arg(y, 0))?.unwrap_or(0);
    let mut result = Vec::new();
    for row in x {
        let Value::Array(row) = row else {
            unreachable!()
        };
        let mut out = Vec::new();
        for col in 0..columns {
            let mut total = 0.0;
            for (k, n) in row.iter().enumerate() {
                total += to_js_number(n) * to_js_number(&index(&arg(y, k), col)?)
            }
            out.push(Value::Number(total))
        }
        result.push(Value::Array(out))
    }
    Ok(Value::Array(result))
}
fn dispatch_stat(name: &str, args: &[Value]) -> Result<Value, Failure> {
    // The statistics task owns these bodies; the final production registry is
    // populated before any formulas are served. Do not duplicate their algorithms.
    let f = crate::registry::library()
        .resolve(name)
        .ok_or_else(|| Failure::unsupported(format!("{name} is not implemented")))?;
    f(args)
}
fn aggregate_kind(n: f64, ref1: Value, ref2: Value) -> Result<Value, Failure> {
    let name = match n {
        1.0 => "AVERAGE",
        2.0 => "COUNT",
        3.0 => "COUNTA",
        4.0 => "MAX",
        5.0 => "MIN",
        6.0 => return product(&[ref1]),
        7.0 => "STDEV.S",
        8.0 => "STDEV.P",
        9.0 => return sum(&[ref1]),
        10.0 => "VAR.S",
        11.0 => "VAR.P",
        12.0 => "MEDIAN",
        13.0 => "MODE.SNGL",
        14.0 => "LARGE",
        15.0 => "SMALL",
        16.0 => "PERCENTILE.INC",
        17.0 => "QUARTILE.INC",
        18.0 => "PERCENTILE.EXC",
        19.0 => "QUARTILE.EXC",
        _ => return Ok(Value::Undefined),
    };
    if n >= 14.0 {
        dispatch_stat(name, &[ref1, ref2])
    } else {
        dispatch_stat(name, &[ref1])
    }
}
pub fn aggregate(a: &[Value]) -> Result<Value, Failure> {
    let n = match parse_number(&arg(a, 0)) {
        Value::Number(n) => n,
        _ => return err(E::Value),
    };
    if matches!(parse_number(&Value::Number(n)), Value::Error(_)) {
        return err(E::Value);
    }
    aggregate_kind(n, arg(a, 2), arg(a, 3))
}
pub fn subtotal(a: &[Value]) -> Result<Value, Failure> {
    let n = match parse_number(&arg(a, 0)) {
        Value::Number(n) => n,
        Value::Error(e) => return err(e),
        _ => unreachable!(),
    };
    let n = if (101.0..=111.0).contains(&n) {
        n - 100.0
    } else {
        n
    };
    if !(1.0..=11.0).contains(&n) {
        return Ok(Value::Undefined);
    }
    aggregate_kind(n, arg(a, 1), Value::Undefined)
}

pub const FUNCTIONS: Table = &[
    ("ABS", abs),
    ("ACOS", acos),
    ("ACOSH", acosh),
    ("ACOT", acot),
    ("ACOTH", acoth),
    ("AGGREGATE", aggregate),
    ("ARABIC", arabic),
    ("ASIN", asin),
    ("ASINH", asinh),
    ("ATAN", atan),
    ("ATAN2", atan2),
    ("ATANH", atanh),
    ("BASE", base),
    ("CEILING", ceiling),
    ("CEILING.MATH", ceiling_math),
    ("CEILING.PRECISE", ceiling_precise),
    ("CEILINGMATH", ceiling_math),
    ("CEILINGPRECISE", ceiling_precise),
    ("ISO.CEILING", ceiling),
    ("ISO.CEILING.MATH", ceiling_math),
    ("ISO.CEILING.PRECISE", ceiling_precise),
    ("COMBIN", combin),
    ("COMBINA", combina),
    ("COS", cos),
    ("COSH", cosh),
    ("COT", cot),
    ("COTH", coth),
    ("CSC", csc),
    ("CSCH", csch),
    ("DECIMAL", decimal),
    ("DEGREES", degrees),
    ("EVEN", even),
    ("EXP", exp),
    ("FACT", fact),
    ("FACTDOUBLE", factdouble),
    ("FLOOR", floor),
    ("FLOOR.MATH", floor_math),
    ("FLOOR.PRECISE", floor_precise),
    ("FLOORMATH", floor_math),
    ("FLOORPRECISE", floor_precise),
    ("GCD", gcd),
    ("INT", int),
    ("LCM", lcm),
    ("LN", ln),
    ("LOG", log),
    ("LOG10", log10),
    ("MMULT", mmult),
    ("MOD", modulo),
    ("MROUND", mround),
    ("MULTINOMIAL", multinomial),
    ("MUNIT", munit),
    ("ODD", odd),
    ("PI", pi),
    ("POWER", power),
    ("PRODUCT", product),
    ("QUOTIENT", quotient),
    ("RADIANS", radians),
    ("RAND", rand),
    ("RANDBETWEEN", randbetween),
    ("ROMAN", roman),
    ("ROUND", round),
    ("ROUNDDOWN", rounddown),
    ("ROUNDUP", roundup),
    ("SEC", sec),
    ("SECH", sech),
    ("SERIESSUM", seriessum),
    ("SIGN", sign),
    ("SIN", sin),
    ("SINH", sinh),
    ("SQRT", sqrt),
    ("SQRTPI", sqrtpi),
    ("SUBTOTAL", subtotal),
    ("SUM", sum),
    ("SUMIF", sumif),
    ("SUMIFS", sumifs),
    ("SUMPRODUCT", sumproduct),
    ("SUMSQ", sumsq),
    ("SUMX2MY2", sumx2my2),
    ("SUMX2PY2", sumx2py2),
    ("SUMXMY2", sumxmy2),
    ("TAN", tan),
    ("TANH", tanh),
    ("TRUNC", trunc),
];
