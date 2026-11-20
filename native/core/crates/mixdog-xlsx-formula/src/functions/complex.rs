//! Complex functions from formulajs 4.6.1. Copyright (c) 2014 Sutoiku, Inc.
//! MIT license retained in fixtures/office-engineering/LICENSE.formulajs.
//! Preserve string-valued coefficients and strict-zero tests: normalising every
//! coefficient to f64 at the parser would change the original's behaviour.
use super::engineering::arg;
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::math as m;

fn zero(v: &V) -> bool {
    matches!(v,V::Number(n)if *n==0.0)
}
fn numeric(n: f64) -> V {
    V::Number(n)
}
fn coefficient(value: &V, imaginary: bool) -> V {
    if matches!(value, V::Undefined | V::Bool(_)) {
        return V::Error(E::Value);
    }
    if zero(value) || matches!(value,V::Text(s)if s=="0") {
        return numeric(0.0);
    }
    if let V::Text(s) = value {
        if imaginary && (s == "i" || s == "j") {
            return numeric(1.0);
        }
        if !imaginary && ["i", "+i", "1i", "+1i", "-i", "-1i", "j", "+j", "1j", "+1j", "-j", "-1j"].contains(&s.as_str()) {
            return numeric(0.0);
        }
    }
    let Ok(mut s) = String::from_utf16(&to_js_utf16(value)) else {
        return V::Error(E::Num);
    };
    if imaginary {
        s = s.replacen("+i", "+1i", 1).replacen("-i", "-1i", 1).replacen("+j", "+1j", 1).replacen("-j", "-1j", 1)
    }
    let plus = s.find('+').and_then(|i| if i == 0 { s[1..].find('+').map(|i| i + 1) } else { Some(i) });
    let minus = s.find('-').and_then(|i| if i == 0 { s[1..].find('-').map(|i| i + 1) } else { Some(i) });
    let unit = s.ends_with(['i', 'j']);
    if let Some(at) = plus.or(minus) {
        if !unit {
            return V::Error(E::Num);
        }
        let a = mixdog_js::string_to_number(&s[..at]);
        let b = mixdog_js::string_to_number(&s[at + 1..s.len() - 1]);
        if a.is_nan() || b.is_nan() {
            return V::Error(E::Num);
        }
        return numeric(if imaginary { if plus.is_some() { b } else { -b } } else { a });
    }
    if unit {
        let s = &s[..s.len() - 1];
        if mixdog_js::string_to_number(s).is_nan() {
            V::Error(E::Num)
        } else if imaginary {
            V::Text(s.into())
        } else {
            numeric(0.0)
        }
    } else if mixdog_js::string_to_number(&s).is_nan() {
        V::Error(E::Num)
    } else if imaginary {
        numeric(0.0)
    } else {
        V::Text(s)
    }
}
fn parts(value: &V) -> (V, V) {
    (coefficient(value, false), coefficient(value, true))
}
fn suffix(v: &V, label: &str) -> Result<&'static str, Failure> {
    match v {
        V::Text(s) => Ok(if s.ends_with('j') { "j" } else { "i" }),
        V::Utf16(units) => Ok(if units.last() == Some(&u16::from(b'j')) { "j" } else { "i" }),
        _ => Err(Failure::thrown(format!("{label}.substring is not a function"))),
    }
}
fn complex(real: &V, imaginary: &V, suffix: &V) -> V {
    let real = parse_number(real);
    let imaginary = parse_number(imaginary);
    if any_is_error(&[real.clone(), imaginary.clone()]) {
        return real;
    }
    let suffix = if matches!(suffix, V::Undefined) {
        "i"
    } else if let V::Text(s) = suffix {
        if s == "i" || s == "j" {
            s
        } else {
            return V::Error(E::Value);
        }
    } else {
        return V::Error(E::Value);
    };
    let r = to_js_number(&real);
    let i = to_js_number(&imaginary);
    if r == 0.0 && i == 0.0 {
        return numeric(0.0);
    }
    let im = if i == 1.0 { suffix.into() } else { to_js_string(&imaginary) + suffix };
    if r == 0.0 {
        V::Text(im)
    } else if i == 0.0 {
        V::Text(to_js_string(&real))
    } else {
        V::Text(to_js_string(&real) + if i > 0.0 { "+" } else { "" } + &im)
    }
}
fn result(real: f64, imaginary: f64, unit: &str) -> V {
    complex(&numeric(real), &numeric(imaginary), &V::Text(unit.into()))
}
fn modulus(value: &V) -> V {
    let (x, y) = parts(value);
    if any_is_error(&[x.clone(), y.clone()]) { V::Error(E::Value) } else { numeric(m::sqrt(m::pow(to_js_number(&x), 2.0) + m::pow(to_js_number(&y), 2.0))) }
}
fn argument(value: &V) -> V {
    let (x, y) = parts(value);
    if any_is_error(&[x.clone(), y.clone()]) {
        return V::Error(E::Value);
    }
    let (xn, yn) = (to_js_number(&x), to_js_number(&y));
    if zero(&x) && zero(&y) {
        return V::Error(E::Div0);
    }
    if zero(&x) && yn > 0.0 {
        return numeric(std::f64::consts::PI / 2.0);
    }
    if zero(&x) && yn < 0.0 {
        return numeric(-std::f64::consts::PI / 2.0);
    }
    if zero(&y) && xn > 0.0 {
        return numeric(0.0);
    }
    if zero(&y) && xn < 0.0 {
        return numeric(-std::f64::consts::PI);
    }
    numeric(if xn > 0.0 {
        m::atan(yn / xn)
    } else if xn < 0.0 && yn >= 0.0 {
        m::atan(yn / xn) + std::f64::consts::PI
    } else {
        m::atan(yn / xn) - std::f64::consts::PI
    })
}
fn binary(name: &str, left: &V, right: &V) -> Result<V, Failure> {
    let (a, b) = parts(left);
    let (c, d) = parts(right);
    if any_is_error(&[a.clone(), b.clone(), c.clone(), d.clone()]) {
        return Ok(V::Error(E::Value));
    }
    let u1 = suffix(left, "inumber1")?;
    let u2 = suffix(right, "inumber2")?;
    let u = if u1 == "j" || u2 == "j" { "j" } else { "i" };
    if name == "IMDIV" && zero(&c) && zero(&d) {
        return Ok(V::Error(E::Num));
    }
    let (a, b, c, d) = (to_js_number(&a), to_js_number(&b), to_js_number(&c), to_js_number(&d));
    Ok(if name == "IMSUB" {
        result(a - c, b - d, u)
    } else {
        let den = c * c + d * d;
        result((a * c + b * d) / den, (b * c - a * d) / den, u)
    })
}
macro_rules! functions{($($name:ident),*)=>{$(fn $name(a:&[V])->Result<V,Failure>{run(stringify!($name),a)})*pub const FUNCTIONS:Table=&[$((stringify!($name),$name)),*];};}
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        COMPLEX,
        IMABS,
        IMAGINARY,
        IMARGUMENT,
        IMCONJUGATE,
        IMCOS,
        IMCOSH,
        IMCOT,
        IMDIV,
        IMEXP,
        IMLN,
        IMLOG10,
        IMLOG2,
        IMPOWER,
        IMPRODUCT,
        IMREAL,
        IMSEC,
        IMSECH,
        IMSIN,
        IMSINH,
        IMSQRT,
        IMCSC,
        IMCSCH,
        IMSUB,
        IMSUM,
        IMTAN
    );
}
pub use exports::FUNCTIONS;
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let value = arg(a, 0);
    match name {
        "COMPLEX" => return Ok(complex(&value, &arg(a, 1), &arg(a, 2))),
        "IMREAL" => return Ok(coefficient(&value, false)),
        "IMAGINARY" => return Ok(coefficient(&value, true)),
        "IMABS" => return Ok(modulus(&value)),
        "IMARGUMENT" => return Ok(argument(&value)),
        "IMDIV" | "IMSUB" => return binary(name, &value, &arg(a, 1)),
        "IMSUM" => {
            if a.is_empty() {
                return Ok(V::Error(E::Value));
            }
            let (mut re, mut im) = (0.0, 0.0);
            for v in flatten(a) {
                re += to_js_number(&coefficient(&v, false));
                im += to_js_number(&coefficient(&v, true));
            }
            return Ok(result(re, im, "i"));
        }
        "IMPRODUCT" => {
            if a.is_empty() {
                return Ok(V::Error(E::Value));
            }
            let mut value = value;
            for next in &a[1..] {
                let (a, b) = parts(&value);
                let (c, d) = parts(next);
                if any_is_error(&[a.clone(), b.clone(), c.clone(), d.clone()]) {
                    return Ok(V::Error(E::Value));
                }
                let (a, b, c, d) = (to_js_number(&a), to_js_number(&b), to_js_number(&c), to_js_number(&d));
                value = result(a * c - b * d, a * d + b * c, "i")
            }
            return Ok(value);
        }
        _ => {}
    }
    if matches!(name, "IMCSC" | "IMCSCH" | "IMSEC" | "IMTAN") && matches!(value, V::Bool(_)) {
        return Ok(V::Error(E::Value));
    }
    let (x, y) = parts(&value);
    let power = parse_number(&arg(a, 1));
    if any_is_error(&[x.clone(), y.clone()]) || (name == "IMPOWER" && matches!(power, V::Error(_))) {
        return Ok(V::Error(if matches!(name, "IMCSC" | "IMCSCH") { E::Num } else { E::Value }));
    }
    // Reciprocal wrappers call their underlying function first; they do not
    // inspect a suffix themselves. Inner calls can return a numeric zero and
    // make IMDIV throw, which is deliberately retained.
    match name {
        "IMCOT" => return binary("IMDIV", &run("IMCOS", a)?, &run("IMSIN", a)?),
        "IMTAN" => return binary("IMDIV", &run("IMSIN", a)?, &run("IMCOS", a)?),
        "IMSEC" | "IMSECH" | "IMCSC" | "IMCSCH" => {
            let underlying = match name {
                "IMSEC" => "IMCOS",
                "IMSECH" => "IMCOSH",
                "IMCSC" => "IMSIN",
                _ => "IMSINH",
            };
            return binary("IMDIV", &V::Text("1".into()), &run(underlying, a)?);
        }
        _ => {}
    }
    let unit = suffix(&value, "inumber")?;
    if name == "IMCONJUGATE" {
        return Ok(if !zero(&y) { complex(&x, &numeric(-to_js_number(&y)), &V::Text(unit.into())) } else { value });
    }
    let (x, y) = (to_js_number(&x), to_js_number(&y));
    let result = match name {
        "IMCOS" => result((m::cos(x) * (m::exp(y) + m::exp(-y))) / 2.0, (-m::sin(x) * (m::exp(y) - m::exp(-y))) / 2.0, unit),
        "IMCOSH" => result((m::cos(y) * (m::exp(x) + m::exp(-x))) / 2.0, (m::sin(y) * (m::exp(x) - m::exp(-x))) / 2.0, unit),
        "IMSIN" => result((m::sin(x) * (m::exp(y) + m::exp(-y))) / 2.0, (m::cos(x) * (m::exp(y) - m::exp(-y))) / 2.0, unit),
        "IMSINH" => result((m::cos(y) * (m::exp(x) - m::exp(-x))) / 2.0, (m::sin(y) * (m::exp(x) + m::exp(-x))) / 2.0, unit),
        "IMEXP" => {
            let e = m::exp(x);
            result(e * m::cos(y), e * m::sin(y), unit)
        }
        "IMLN" => result(m::ln(m::sqrt(x * x + y * y)), m::atan(y / x), unit),
        "IMLOG10" | "IMLOG2" => {
            let denominator = m::ln(if name == "IMLOG10" { 10.0 } else { 2.0 });
            result(m::ln(m::sqrt(x * x + y * y)) / denominator, m::atan(y / x) / denominator, unit)
        }
        "IMPOWER" => {
            let number = to_js_number(&power);
            let p = m::pow(to_js_number(&modulus(&value)), number);
            let t = to_js_number(&argument(&value));
            result(p * m::cos(number * t), p * m::sin(number * t), unit)
        }
        "IMSQRT" => {
            let s = m::sqrt(to_js_number(&modulus(&value)));
            let t = to_js_number(&argument(&value));
            result(s * m::cos(t / 2.0), s * m::sin(t / 2.0), unit)
        }
        _ => unreachable!(),
    };
    Ok(result)
}
