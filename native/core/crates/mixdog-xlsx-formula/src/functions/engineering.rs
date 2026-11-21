//! Engineering functions from formulajs 4.6.1. Copyright (c) 2014 Sutoiku, Inc.
//! MIT license retained in fixtures/office-engineering/LICENSE.formulajs.
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::{math as m, number_to_radix, parse_int_radix};

pub(super) fn arg(a: &[V], i: usize) -> V {
    a.get(i).cloned().unwrap_or(V::Undefined)
}
pub(super) fn num(v: &V) -> Result<f64, E> {
    match parse_number(v) {
        V::Number(n) => Ok(n),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
pub(super) fn int32(n: f64) -> i32 {
    if !n.is_finite() {
        0
    } else {
        let n = n.trunc().rem_euclid(4294967296.0);
        if n >= 2147483648.0 { (n - 4294967296.0) as i32 } else { n as i32 }
    }
}
fn radix(n: f64, r: u32) -> String {
    number_to_radix(n, r as f64).expect("fixed valid radix")
}
fn valid(s: &str, base: u32, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|c| match c {
            b'0'..=b'9' => ((c - b'0') as u32) < base,
            b'a'..=b'f' => ((c - b'a' + 10) as u32) < base,
            b'A'..=b'F' => ((c - b'A' + 10) as u32) < base,
            _ => false,
        })
}
fn pad(result: String, places: &V) -> Result<V, Failure> {
    if matches!(places, V::Undefined) {
        return Ok(V::Text(result));
    }
    let places = to_js_number(places);
    if places.is_nan() {
        return Ok(V::Error(E::Value));
    }
    if places < 0.0 {
        return Ok(V::Error(E::Num));
    }
    let places = m::floor(places);
    // Nothing here is longer than ten digits, so wider padding is refused before it is allocated.
    if places > 10.0 || places < result.len() as f64 {
        return Ok(V::Error(E::Num));
    }
    let count = places - result.len() as f64;
    // REPT is new Array(count+1).join('0'), whose array-length bound is observable.
    if !count.is_finite() || count + 1.0 > u32::MAX as f64 {
        return Err(Failure::thrown("Invalid array length"));
    }
    // V8 rejects oversized strings before allocating the Array.join padding.
    if places > 536_870_888.0 {
        return Err(Failure::thrown("Invalid string length"));
    }
    let mut out = String::new();
    out.try_reserve(places as usize).map_err(|_| Failure::thrown("Invalid string length"))?;
    out.extend(std::iter::repeat_n('0', count as usize));
    out.push_str(&result);
    Ok(V::Text(out))
}
fn negative_binary(n: f64) -> String {
    let s = radix(512.0 + n, 2);
    format!("1{}{s}", "0".repeat(9 - s.len()))
}
fn conversion(name: &str, number: &V, places: &V) -> Result<V, Failure> {
    let mut input = number.clone();
    let base = match &name[..3] {
        "DEC" => 10,
        "BIN" => 2,
        "HEX" => 16,
        _ => 8,
    };
    let target = match &name[4..] {
        "DEC" => 10,
        "BIN" => 2,
        "HEX" => 16,
        _ => 8,
    };
    if base == 10 {
        input = parse_number(&input);
        if matches!(input, V::Error(_)) {
            return Ok(input);
        }
    }
    let Ok(s) = String::from_utf16(&to_js_utf16(&input)) else {
        return Ok(V::Error(E::Num));
    };
    let maximum = if base == 10 {
        match target {
            2 => 3,
            16 => 12,
            _ => 9,
        }
    } else {
        10
    };
    let digits = if base == 10 { s.strip_prefix('-').unwrap_or(&s) } else { &s };
    if !valid(digits, base, maximum) {
        return Ok(V::Error(E::Num));
    }
    let n = parse_int_radix(&s, base as f64);
    if base == 10 {
        let limit = match target {
            2 => 512.0,
            16 => 549755813888.0,
            _ => 536870912.0,
        };
        if n < -limit || n > limit - 1.0 {
            return Ok(V::Error(E::Num));
        }
        if n < 0.0 {
            return Ok(V::Text(if target == 2 { negative_binary(n) } else { radix(2.0 * limit + n, target) }));
        }
    }
    if base == 2 && s.len() == 10 && s.starts_with('1') {
        let tail = parse_int_radix(&s[1..], 2.0);
        return Ok(match target {
            10 => V::Number(tail - 512.0),
            16 => V::Text(radix(1099511627264.0 + tail, 16)),
            _ => V::Text(radix(1073741312.0 + tail, 8)),
        });
    }
    if base == 16 {
        if target == 10 {
            return Ok(V::Number(if n >= 549755813888.0 { n - 1099511627776.0 } else { n }));
        }
        if target == 8 {
            if n > 536870911.0 && n < 1098974756864.0 {
                return Ok(V::Error(E::Num));
            }
            if n >= 1098974756864.0 {
                return Ok(V::Text(radix(n - 1098437885952.0, 8)));
            }
        }
    }
    if base == 8 {
        if target == 10 {
            return Ok(V::Number(if n >= 536870912.0 { n - 1073741824.0 } else { n }));
        }
        if target == 16 && n >= 536870912.0 {
            return Ok(V::Text("ff".to_owned() + &radix(n + 3221225472.0, 16)));
        }
    }
    if (base == 8 || base == 16) && target == 2 {
        // Source tests number.length, not String(number).length. Numeric inputs
        // and one-element arrays must not acquire string-only sign handling.
        let negative = matches!(input,V::Text(ref t) if t.len()==10&&t.as_bytes()[0].to_ascii_lowercase()==if base==8{b'7'}else{b'f'});
        let decimal = if negative { n - if base == 8 { 1073741824.0 } else { 1099511627776.0 } } else { n };
        if !(-512.0..=511.0).contains(&decimal) {
            return Ok(V::Error(E::Num));
        }
        if negative {
            return Ok(V::Text(negative_binary(decimal)));
        }
        return pad(radix(decimal, 2), places);
    }
    if target == 10 { Ok(V::Number(n)) } else { pad(radix(n, target), places) }
}

// This polynomial is jStat 1.9.6 erf, in its original evaluation order.
// Copyright jStat contributors; MIT license retained in LICENSE.jstat in the fixture set.
// It is shared by ERF/ERFC.
pub(crate) fn erf(value: &V) -> f64 {
    #[allow(clippy::excessive_precision, reason = "coefficients are preserved verbatim from the pinned jStat implementation")]
    const COF: [f64; 28] = [
        -1.3026537197817094,
        6.4196979235649026e-1,
        1.9476473204185836e-2,
        -9.561514786808631e-3,
        -9.46595344482036e-4,
        3.66839497852761e-4,
        4.2523324806907e-5,
        -2.0278578112534e-5,
        -1.624290004647e-6,
        1.303655835580e-6,
        1.5626441722e-8,
        -8.5238095915e-8,
        6.529054439e-9,
        5.059343495e-9,
        -9.91364156e-10,
        -2.27365122e-10,
        9.6467911e-11,
        2.394038e-12,
        -6.886027e-12,
        8.94487e-13,
        3.13092e-13,
        -1.12708e-13,
        3.81e-16,
        7.106e-15,
        -1.523e-15,
        -9.4e-17,
        1.21e-16,
        -2.8e-17,
    ];
    let negative = to_js_number(value) < 0.0;
    let x = if negative { V::Number(-to_js_number(value)) } else { value.clone() };
    let denominator = match &x {
        V::Text(_) | V::Utf16(_) | V::Array(_) | V::Date(_) | V::Error(_) => {
            let mut units = vec![u16::from(b'2')];
            units.extend(to_js_utf16(&x));
            to_js_number(&V::from_utf16(units))
        }
        _ => 2.0 + to_js_number(&x),
    };
    let t = 2.0 / denominator;
    let ty = 4.0 * t - 2.0;
    let (mut d, mut dd) = (0.0, 0.0);
    for j in (1..COF.len()).rev() {
        let tmp = d;
        d = ty * d - dd + COF[j];
        dd = tmp
    }
    let x = to_js_number(&x);
    let res = t * m::exp(-x * x + 0.5 * (COF[0] + ty * d) - dd);
    if negative { res - 1.0 } else { 1.0 - res }
}

#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        BESSELI, BESSELJ, BESSELK, BESSELY, BIN2DEC, BIN2HEX, BIN2OCT, BITAND, BITLSHIFT, BITOR, BITRSHIFT, BITXOR, CONVERT, DEC2BIN, DEC2HEX, DEC2OCT, DELTA,
        ERF, ERFC, GESTEP, HEX2BIN, HEX2DEC, HEX2OCT, OCT2BIN, OCT2DEC, OCT2HEX
    );
}
pub use exports::FUNCTIONS;
fn bit_operation(name: &str, x: &V, y: &V) -> Result<V, Failure> {
    let (Ok(x), Ok(y)) = (num(x), num(y)) else {
        return Ok(V::Error(E::Value));
    };
    let shift = name.ends_with("SHIFT");
    if x < 0.0 || m::floor(x) != x || x > 281474976710655.0 || if shift { m::abs(y) > 53.0 } else { y < 0.0 || m::floor(y) != y || y > 281474976710655.0 } {
        return Ok(V::Error(E::Num));
    }
    let a = int32(x);
    let b = int32(y);
    let out = match name {
        "BITAND" => a & b,
        "BITOR" => a | b,
        "BITXOR" => a ^ b,
        _ => {
            let left = (name == "BITLSHIFT") == (y >= 0.0);
            let count = (int32(if y >= 0.0 { y } else { -y }) as u32) & 31;
            if left { a.wrapping_shl(count) } else { a >> count }
        }
    };
    Ok(V::Number(f64::from(out)))
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let (x, y, z) = (arg(a, 0), arg(a, 1), arg(a, 2));
    if name.contains('2') {
        let result = conversion(name, &x, &y)?;
        // Spreadsheets print hexadecimal digits upper-case; JS toString(16) is lower-case.
        return Ok(match result {
            V::Text(t) if name.ends_with("HEX") => V::Text(t.to_uppercase()),
            other => other,
        });
    }
    if name.starts_with("BESSEL") {
        let (Ok(x), Ok(n)) = (num(&x), num(&y)) else {
            return Ok(V::Error(E::Value));
        };
        return Ok(V::Number(match name {
            "BESSELI" => super::bessel::i(x, n),
            "BESSELJ" => super::bessel::j(x, n),
            "BESSELK" => super::bessel::k(x, n),
            _ => super::bessel::y(x, n),
        }));
    }
    if name.starts_with("BIT") {
        return bit_operation(name, &x, &y);
    }
    match name {
        "DELTA" => {
            let (Ok(x), Ok(y)) = (num(&x), num(&y)) else {
                return Ok(V::Error(E::Value));
            };
            Ok(V::Number(if x == y { 1.0 } else { 0.0 }))
        }
        "GESTEP" => {
            let step = if is_truthy(&y) { y } else { V::Number(0.0) };
            let n = parse_number(&x);
            if any_is_error(&[n.clone(), step.clone()]) {
                return Ok(n);
            }
            Ok(V::Number(if to_js_number(&n) >= to_js_number(&step) { 1.0 } else { 0.0 }))
        }
        "ERF" => {
            let (Ok(x), Ok(_)) = (num(&x), num(&y)) else {
                return Ok(V::Error(E::Value));
            };
            Ok(V::Number(erf(&V::Number(x))))
        }
        "ERFC" => {
            if is_nan_of(&x) {
                Ok(V::Error(E::Value))
            } else {
                Ok(V::Number(1.0 - erf(&x)))
            }
        }
        "CONVERT" => {
            let n = parse_number(&x);
            if matches!(n, V::Error(_)) {
                return Ok(n);
            }
            let from = unit(&y, "from_unit")?;
            let to = unit(&z, "to_unit")?;
            match (from, to) {
                (Some((from, f)), Some((to, t))) if from.quantity == to.quantity => Ok(V::Number((to_js_number(&n) * from.ratio * f) / (to.ratio * t))),
                _ => Ok(V::Error(E::Na)),
            }
        }
        _ => unreachable!(),
    }
}
struct Unit {
    symbol: &'static str,
    aliases: &'static [&'static str],
    quantity: &'static str,
    ratio: f64,
}
const BINARY_PREFIXES: &[(&str, f64)] = &[
    ("Yi", 1208925819614629174706176.0),
    ("Zi", 1180591620717411303424.0),
    ("Ei", 1152921504606846976.0),
    ("Pi", 1125899906842624.0),
    ("Ti", 1099511627776.0),
    ("Gi", 1073741824.0),
    ("Mi", 1048576.0),
    ("ki", 1024.0),
];
const DECIMAL_PREFIXES: &[(&str, f64)] = &[
    ("da", 1e1),
    ("Y", 1e24),
    ("Z", 1e21),
    ("E", 1e18),
    ("P", 1e15),
    ("T", 1e12),
    ("G", 1e9),
    ("M", 1e6),
    ("k", 1e3),
    ("h", 1e2),
    ("e", 1e1),
    ("d", 1e-1),
    ("c", 1e-2),
    ("m", 1e-3),
    ("u", 1e-6),
    ("n", 1e-9),
    ("p", 1e-12),
    ("f", 1e-15),
    ("a", 1e-18),
    ("z", 1e-21),
    ("y", 1e-24),
];
fn unit(value: &V, label: &str) -> Result<Option<(&'static Unit, f64)>, Failure> {
    let lookup = |s: &str| UNITS.iter().rev().find(|u| u.symbol == s || u.aliases.contains(&s));
    if let V::Text(s) = value
        && let Some(u) = lookup(s)
    {
        return Ok(Some((u, 1.0)));
    }
    if matches!(value, V::Utf16(_)) {
        return Ok(None);
    }
    let V::Text(s) = value else {
        return Err(Failure::thrown(match value {
            V::Undefined => "Cannot read properties of undefined (reading 'substring')".into(),
            V::Null => "Cannot read properties of null (reading 'substring')".into(),
            _ => format!("{label}.substring is not a function"),
        }));
    };
    for &(prefix, ratio) in BINARY_PREFIXES.iter().chain(DECIMAL_PREFIXES) {
        if let Some(base) = s.strip_prefix(prefix) {
            return Ok(lookup(base).map(|u| (u, ratio)));
        }
    }
    Ok(None)
}

// Original CONVERT table order matters: later aliases override earlier symbols.
const UNITS: &[Unit] = &[
    Unit { symbol: "?", aliases: &[], quantity: "action", ratio: 1.05457168181818e-34 },
    Unit { symbol: "e", aliases: &[], quantity: "electric_charge", ratio: 1.60217653141414e-19 },
    Unit { symbol: "Eh", aliases: &[], quantity: "energy", ratio: 4.35974417757576e-18 },
    Unit { symbol: "a?", aliases: &[], quantity: "length", ratio: 5.29177210818182e-11 },
    Unit { symbol: "m?", aliases: &[], quantity: "mass", ratio: 9.10938261616162e-31 },
    Unit { symbol: "?/Eh", aliases: &[], quantity: "time", ratio: 2.41888432650516e-17 },
    Unit { symbol: "admkn", aliases: &[], quantity: "speed", ratio: 0.514773333 },
    Unit { symbol: "A", aliases: &[], quantity: "electric_current", ratio: 1.0 },
    Unit { symbol: "A/m", aliases: &[], quantity: "magnetic_field_intensity", ratio: 1.0 },
    Unit { symbol: "Å", aliases: &["ang"], quantity: "length", ratio: 1e-10 },
    Unit { symbol: "ar", aliases: &[], quantity: "area", ratio: 100.0 },
    Unit { symbol: "ua", aliases: &[], quantity: "length", ratio: 1.49597870691667e-11 },
    Unit { symbol: "bar", aliases: &[], quantity: "pressure", ratio: 100000.0 },
    Unit { symbol: "b", aliases: &[], quantity: "area", ratio: 1e-28 },
    Unit { symbol: "Bq", aliases: &[], quantity: "radioactivity", ratio: 1.0 },
    Unit { symbol: "bit", aliases: &["b"], quantity: "information", ratio: 1.0 },
    Unit { symbol: "BTU", aliases: &["btu"], quantity: "energy", ratio: 1055.05585262 },
    Unit { symbol: "byte", aliases: &[], quantity: "information", ratio: 8.0 },
    Unit { symbol: "cd", aliases: &[], quantity: "luminous_intensity", ratio: 1.0 },
    Unit { symbol: "cd/m?", aliases: &[], quantity: "luminance", ratio: 1.0 },
    Unit { symbol: "C", aliases: &[], quantity: "electric_charge", ratio: 1.0 },
    Unit { symbol: "ang3", aliases: &["ang^3"], quantity: "volume", ratio: 1e-30 },
    Unit { symbol: "ft3", aliases: &["ft^3"], quantity: "volume", ratio: 0.028316846592 },
    Unit { symbol: "in3", aliases: &["in^3"], quantity: "volume", ratio: 0.000016387064 },
    Unit { symbol: "ly3", aliases: &["ly^3"], quantity: "volume", ratio: 8.46786664623715e-47 },
    Unit { symbol: "m3", aliases: &["m^3"], quantity: "volume", ratio: 1.0 },
    Unit { symbol: "mi3", aliases: &["mi^3"], quantity: "volume", ratio: 4168181825.44058 },
    Unit { symbol: "Nmi3", aliases: &["Nmi^3"], quantity: "volume", ratio: 6352182208.0 },
    Unit { symbol: "Pica3", aliases: &["Picapt3", "Pica^3", "Picapt^3"], quantity: "volume", ratio: 7.58660370370369e-8 },
    Unit { symbol: "yd3", aliases: &["yd^3"], quantity: "volume", ratio: 0.764554857984 },
    Unit { symbol: "cup", aliases: &[], quantity: "volume", ratio: 0.0002365882365 },
    Unit { symbol: "Da", aliases: &["u"], quantity: "mass", ratio: 1.66053886282828e-27 },
    Unit { symbol: "d", aliases: &["day"], quantity: "time", ratio: 86400.0 },
    Unit { symbol: "°", aliases: &[], quantity: "angle", ratio: 0.0174532925199433 },
    Unit { symbol: "Rank", aliases: &[], quantity: "temperature", ratio: 0.555555555555556 },
    Unit { symbol: "dyn", aliases: &["dy"], quantity: "force", ratio: 0.00001 },
    Unit { symbol: "eV", aliases: &["ev"], quantity: "energy", ratio: 1.60217656514141 },
    Unit { symbol: "ell", aliases: &[], quantity: "length", ratio: 1.143 },
    Unit { symbol: "erg", aliases: &["e"], quantity: "energy", ratio: 1e-7 },
    Unit { symbol: "F", aliases: &[], quantity: "electric_capacitance", ratio: 1.0 },
    Unit { symbol: "oz", aliases: &[], quantity: "volume", ratio: 0.0000295735295625 },
    Unit { symbol: "ft", aliases: &[], quantity: "length", ratio: 0.3048 },
    Unit { symbol: "flb", aliases: &[], quantity: "energy", ratio: 1.3558179483314 },
    Unit { symbol: "Gal", aliases: &[], quantity: "acceleration", ratio: 0.01 },
    Unit { symbol: "gal", aliases: &[], quantity: "volume", ratio: 0.003785411784 },
    Unit { symbol: "G", aliases: &["ga"], quantity: "magnetic_flux_density", ratio: 1.0 },
    Unit { symbol: "grain", aliases: &[], quantity: "mass", ratio: 0.0000647989 },
    Unit { symbol: "g", aliases: &[], quantity: "mass", ratio: 0.001 },
    Unit { symbol: "Gy", aliases: &[], quantity: "absorbed_dose", ratio: 1.0 },
    Unit { symbol: "GRT", aliases: &["regton"], quantity: "volume", ratio: 2.8316846592 },
    Unit { symbol: "ha", aliases: &[], quantity: "area", ratio: 10000.0 },
    Unit { symbol: "H", aliases: &[], quantity: "inductance", ratio: 1.0 },
    Unit { symbol: "Hz", aliases: &[], quantity: "frequency", ratio: 1.0 },
    Unit { symbol: "HP", aliases: &["h"], quantity: "power", ratio: 745.69987158227 },
    Unit { symbol: "HPh", aliases: &["hh", "hph"], quantity: "energy", ratio: 2684519.538 },
    Unit { symbol: "h", aliases: &["hr"], quantity: "time", ratio: 3600.0 },
    Unit { symbol: "uk_gal", aliases: &[], quantity: "volume", ratio: 0.00454609 },
    Unit { symbol: "lcwt", aliases: &["uk_cwt", "hweight"], quantity: "mass", ratio: 50.802345 },
    Unit { symbol: "uk_qt", aliases: &[], quantity: "volume", ratio: 0.0011365225 },
    Unit { symbol: "brton", aliases: &["uk_ton", "LTON"], quantity: "mass", ratio: 1016.046909 },
    Unit { symbol: "in", aliases: &[], quantity: "length", ratio: 0.0254 },
    Unit { symbol: "uk_acre", aliases: &[], quantity: "area", ratio: 4046.8564224 },
    Unit { symbol: "cal", aliases: &[], quantity: "energy", ratio: 4.1868 },
    Unit { symbol: "J", aliases: &[], quantity: "energy", ratio: 1.0 },
    Unit { symbol: "kat", aliases: &[], quantity: "catalytic_activity", ratio: 1.0 },
    Unit { symbol: "K", aliases: &["kel"], quantity: "temperature", ratio: 1.0 },
    Unit { symbol: "kg", aliases: &[], quantity: "mass", ratio: 1.0 },
    Unit { symbol: "kn", aliases: &[], quantity: "speed", ratio: 0.514444444444444 },
    Unit { symbol: "ly", aliases: &[], quantity: "length", ratio: 9460730472580800.0 },
    Unit { symbol: "L", aliases: &["l", "lt"], quantity: "volume", ratio: 0.001 },
    Unit { symbol: "lm", aliases: &[], quantity: "luminous_flux", ratio: 1.0 },
    Unit { symbol: "lx", aliases: &[], quantity: "illuminance", ratio: 1.0 },
    Unit { symbol: "Mx", aliases: &[], quantity: "magnetic_flux", ratio: 1e-18 },
    Unit { symbol: "MTON", aliases: &[], quantity: "volume", ratio: 1.13267386368 },
    Unit { symbol: "m/h", aliases: &["m/hr"], quantity: "speed", ratio: 0.00027777777777778 },
    Unit { symbol: "m/s", aliases: &["m/sec"], quantity: "speed", ratio: 1.0 },
    Unit { symbol: "m?s??", aliases: &[], quantity: "acceleration", ratio: 1.0 },
    Unit { symbol: "pc", aliases: &["parsec"], quantity: "length", ratio: 30856775814671900.0 },
    Unit { symbol: "m?/s", aliases: &[], quantity: "kinematic_viscosity", ratio: 1.0 },
    Unit { symbol: "m", aliases: &[], quantity: "length", ratio: 1.0 },
    Unit { symbol: "mph", aliases: &[], quantity: "speed", ratio: 0.44704 },
    Unit { symbol: "mmHg", aliases: &[], quantity: "pressure", ratio: 133.322 },
    Unit { symbol: "?", aliases: &[], quantity: "angle", ratio: 0.000290888208665722 },
    Unit { symbol: "min", aliases: &["mn"], quantity: "time", ratio: 60.0 },
    Unit { symbol: "tspm", aliases: &[], quantity: "volume", ratio: 0.000005 },
    Unit { symbol: "mol", aliases: &[], quantity: "amount_of_substance", ratio: 1.0 },
    Unit { symbol: "Morgen", aliases: &[], quantity: "area", ratio: 2500.0 },
    Unit { symbol: "?", aliases: &[], quantity: "action", ratio: 1.05457168181818e-34 },
    Unit { symbol: "m?", aliases: &[], quantity: "mass", ratio: 9.10938261616162e-31 },
    Unit { symbol: "c?", aliases: &[], quantity: "speed", ratio: 299792458.0 },
    Unit { symbol: "?/(me?c??)", aliases: &[], quantity: "time", ratio: 1.28808866778687e-21 },
    Unit { symbol: "M", aliases: &["Nmi"], quantity: "length", ratio: 1852.0 },
    Unit { symbol: "N", aliases: &[], quantity: "force", ratio: 1.0 },
    Unit { symbol: "Oe ", aliases: &[], quantity: "magnetic_field_intensity", ratio: 79.5774715459477 },
    Unit { symbol: "Ω", aliases: &[], quantity: "electric_resistance", ratio: 1.0 },
    Unit { symbol: "ozm", aliases: &[], quantity: "mass", ratio: 0.028349523125 },
    Unit { symbol: "Pa", aliases: &[], quantity: "pressure", ratio: 1.0 },
    Unit { symbol: "Pa?s", aliases: &[], quantity: "dynamic_viscosity", ratio: 1.0 },
    Unit { symbol: "PS", aliases: &[], quantity: "power", ratio: 735.49875 },
    Unit { symbol: "ph", aliases: &[], quantity: "illuminance", ratio: 0.0001 },
    Unit { symbol: "pica", aliases: &[], quantity: "length", ratio: 0.00035277777777778 },
    Unit { symbol: "Pica", aliases: &["Picapt"], quantity: "length", ratio: 0.00423333333333333 },
    Unit { symbol: "P", aliases: &[], quantity: "dynamic_viscosity", ratio: 0.1 },
    Unit { symbol: "pond", aliases: &[], quantity: "force", ratio: 0.00980665 },
    Unit { symbol: "lbf", aliases: &[], quantity: "force", ratio: 4.4482216152605 },
    Unit { symbol: "lbm", aliases: &[], quantity: "mass", ratio: 0.45359237 },
    Unit { symbol: "qt", aliases: &[], quantity: "volume", ratio: 0.000946352946 },
    Unit { symbol: "rad", aliases: &[], quantity: "angle", ratio: 1.0 },
    Unit { symbol: "?", aliases: &[], quantity: "angle", ratio: 0.00000484813681109536 },
    Unit { symbol: "s", aliases: &["sec"], quantity: "time", ratio: 1.0 },
    Unit { symbol: "cwt", aliases: &["shweight"], quantity: "mass", ratio: 45.359237 },
    Unit { symbol: "S", aliases: &[], quantity: "electrical_conductance", ratio: 1.0 },
    Unit { symbol: "Sv", aliases: &[], quantity: "equivalent_dose", ratio: 1.0 },
    Unit { symbol: "sg", aliases: &[], quantity: "mass", ratio: 14.59390294 },
    Unit { symbol: "ang2", aliases: &["ang^2"], quantity: "area", ratio: 1e-20 },
    Unit { symbol: "ft2", aliases: &["ft^2"], quantity: "area", ratio: 0.09290304 },
    Unit { symbol: "in2", aliases: &["in^2"], quantity: "area", ratio: 0.00064516 },
    Unit { symbol: "ly2", aliases: &["ly^2"], quantity: "area", ratio: 8.95054210748189e31 },
    Unit { symbol: "m?", aliases: &[], quantity: "area", ratio: 1.0 },
    Unit { symbol: "mi2", aliases: &["mi^2"], quantity: "area", ratio: 2589988.110336 },
    Unit { symbol: "Nmi2", aliases: &["Nmi^2"], quantity: "area", ratio: 3429904.0 },
    Unit { symbol: "Pica2", aliases: &["Picapt2", "Pica^2", "Picapt^2"], quantity: "area", ratio: 0.00001792111111111 },
    Unit { symbol: "yd2", aliases: &["yd^2"], quantity: "area", ratio: 0.83612736 },
    Unit { symbol: "mi", aliases: &[], quantity: "length", ratio: 1609.344 },
    Unit { symbol: "sr", aliases: &[], quantity: "solid_angle", ratio: 1.0 },
    Unit { symbol: "sb", aliases: &[], quantity: "luminance", ratio: 0.0001 },
    Unit { symbol: "St", aliases: &[], quantity: "kinematic_viscosity", ratio: 0.0001 },
    Unit { symbol: "stone", aliases: &[], quantity: "mass", ratio: 6.35029318 },
    Unit { symbol: "tbs", aliases: &[], quantity: "volume", ratio: 0.0000147868 },
    Unit { symbol: "tsp", aliases: &[], quantity: "volume", ratio: 0.00000492892 },
    Unit { symbol: "T", aliases: &[], quantity: "magnetic_flux_density", ratio: 1.0 },
    Unit { symbol: "c", aliases: &[], quantity: "energy", ratio: 4.184 },
    Unit { symbol: "ton", aliases: &[], quantity: "mass", ratio: 907.18474 },
    Unit { symbol: "t", aliases: &[], quantity: "mass", ratio: 1000.0 },
    Unit { symbol: "uk_pt", aliases: &[], quantity: "volume", ratio: 0.00056826125 },
    Unit { symbol: "bushel", aliases: &[], quantity: "volume", ratio: 0.03523907 },
    Unit { symbol: "barrel", aliases: &[], quantity: "volume", ratio: 0.158987295 },
    Unit { symbol: "pt", aliases: &["us_pt"], quantity: "volume", ratio: 0.000473176473 },
    Unit { symbol: "survey_mi", aliases: &[], quantity: "length", ratio: 1609.347219 },
    Unit { symbol: "us_acre", aliases: &[], quantity: "area", ratio: 4046.87261 },
    Unit { symbol: "V", aliases: &[], quantity: "voltage", ratio: 1.0 },
    Unit { symbol: "W", aliases: &[], quantity: "power", ratio: 1.0 },
    Unit { symbol: "Wh", aliases: &["wh"], quantity: "energy", ratio: 3600.0 },
    Unit { symbol: "Wb", aliases: &[], quantity: "magnetic_flux", ratio: 1.0 },
    Unit { symbol: "yd", aliases: &[], quantity: "length", ratio: 0.9144 },
    Unit { symbol: "yr", aliases: &[], quantity: "time", ratio: 31557600.0 },
];
