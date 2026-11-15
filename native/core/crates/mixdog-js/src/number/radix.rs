//! V8 12.4 radix conversion, from official nodejs/node v22.20.0.
//!
//! Translated from v8 numbers/conversions.cc (DoubleToRadixCString, NumberParseIntHelper) and
//! base/numbers/double.h (Double::Exponent/NextDouble); URLs and sha256 in reference/PROVENANCE.md.
//! Copyright 2011-2024 the V8 project authors. All rights reserved.
//! Governed by the BSD-style license in reference/LICENSE.v8.

use super::{number_to_string, radix_literal};
use crate::text::js_trim_start;

const RADIX_ERROR: &str = "toString() radix argument must be between 2 and 36";

/// Number.prototype.toString with an explicit numeric radix. `undefined` is
/// intentionally not represented here: callers must supply 10 for that default.
/// The radix is ToIntegerOrInfinity, and validated before inspecting the number.
pub fn number_to_radix(number: f64, radix: f64) -> Result<String, String> {
    let radix = radix.trunc();
    if !radix.is_finite() || !(2.0..=36.0).contains(&radix) {
        return Err(RADIX_ERROR.to_owned());
    }
    let radix = radix as u32;
    if radix == 10 || !number.is_finite() || number == 0.0 {
        return Ok(number_to_string(number));
    }
    Ok(double_to_radix(number, radix))
}

/// Double::Exponent is the exponent of the integer significand (52 fraction
/// bits included), not the usual unbiased floating exponent.
fn exponent(value: f64) -> i32 {
    let biased = ((value.to_bits() >> 52) & 0x7ff) as i32;
    if biased == 0 { -1074 } else { biased - 1075 }
}

fn double_to_radix(value: f64, radix: u32) -> String {
    const CHARS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    const MID: usize = 1100;
    let mut buffer = [0u8; MID * 2];
    let mut integer_cursor = MID;
    let mut fraction_cursor = MID;
    let negative = value < 0.0;
    let value = value.abs();
    let radix_f64 = f64::from(radix);
    let mut integer = value.floor();
    let mut fraction = value - integer;
    let next_double = f64::from_bits(value.to_bits() + 1);
    let mut delta = (0.5 * (next_double - value)).max(f64::from_bits(1));
    if fraction >= delta {
        buffer[fraction_cursor] = b'.';
        fraction_cursor += 1;
        loop {
            fraction *= radix_f64;
            delta *= radix_f64;
            let digit = fraction as u32;
            buffer[fraction_cursor] = CHARS[digit as usize];
            fraction_cursor += 1;
            fraction -= f64::from(digit);
            if (fraction > 0.5 || (fraction == 0.5 && digit & 1 != 0)) && fraction + delta > 1.0 {
                loop {
                    fraction_cursor -= 1;
                    if fraction_cursor == MID {
                        integer += 1.0;
                        break;
                    }
                    let ch = buffer[fraction_cursor];
                    let digit = if ch > b'9' { ch - b'a' + 10 } else { ch - b'0' };
                    if u32::from(digit) + 1 < radix {
                        buffer[fraction_cursor] = CHARS[usize::from(digit) + 1];
                        fraction_cursor += 1;
                        break;
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }
    // V8 fills integer digits no longer represented by the double with zeros.
    while exponent(integer / radix_f64) > 0 {
        integer /= radix_f64;
        integer_cursor -= 1;
        buffer[integer_cursor] = b'0';
    }
    loop {
        let remainder = integer % radix_f64;
        integer_cursor -= 1;
        buffer[integer_cursor] = CHARS[remainder as usize];
        integer = (integer - remainder) / radix_f64;
        if integer <= 0.0 {
            break;
        }
    }
    if negative {
        integer_cursor -= 1;
        buffer[integer_cursor] = b'-';
    }
    String::from_utf8(buffer[integer_cursor..fraction_cursor].to_vec()).expect("ASCII radix digits")
}

/// ECMAScript ToInt32 (unlike Number::toString's ToIntegerOrInfinity).
fn to_int32(value: f64) -> i32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    let modulo = value.trunc() % 4_294_967_296.0;
    let unsigned = if modulo < 0.0 {
        modulo + 4_294_967_296.0
    } else {
        modulo
    };
    if unsigned >= 2_147_483_648.0 {
        (unsigned - 4_294_967_296.0) as i32
    } else {
        unsigned as i32
    }
}

fn digit(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some(u32::from(byte - b'0')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 10),
        b'A'..=b'Z' => Some(u32::from(byte - b'A') + 10),
        _ => None,
    }
}

/// JavaScript parseInt(text, radix). Prefix/partial parsing is separate from
/// StringToNumber; only a hexadecimal prefix is recognized when radix is zero.
pub fn parse_int_radix(text: &str, radix: f64) -> f64 {
    let radix = to_int32(radix);
    if radix != 0 && !(2..=36).contains(&radix) {
        return f64::NAN;
    }
    let mut text = js_trim_start(text);
    let negative = text.starts_with('-');
    if text.starts_with(['+', '-']) {
        text = &text[1..];
    }
    let mut radix = radix as u32;
    if (radix == 0 || radix == 16) && (text.starts_with("0x") || text.starts_with("0X")) {
        radix = 16;
        text = &text[2..];
    } else if radix == 0 {
        radix = 10;
    }
    let length = text
        .bytes()
        .take_while(|byte| digit(*byte).is_some_and(|d| d < radix))
        .count();
    if length == 0 {
        return f64::NAN;
    }
    let digits = text[..length].trim_start_matches('0');
    let value = if digits.is_empty() {
        0.0
    } else if radix == 10 {
        // V8 keeps at most 310 non-leading-zero decimal digits for Strtod;
        // 310 or more necessarily overflows. Rust's decimal parse rounds alike.
        if digits.len() > 309 {
            f64::INFINITY
        } else {
            digits.parse::<f64>().expect("decimal digits")
        }
    } else if radix.is_power_of_two() {
        // All power-of-two radices use the same nearest-even significand path.
        // Even radix 2 overflows at this length; avoid building pointless bits.
        if digits.len() > 1100 {
            f64::INFINITY
        } else {
            radix_literal(digits, radix)
        }
    } else {
        generic_integer(digits.as_bytes(), radix)
    };
    if negative { -value } else { value }
}

/// NumberParseIntHelper::HandleGenericCase. The 32-bit chunk boundary is part
/// of V8's observable approximation for non-power-of-two radices, not merely an
/// optimization. Do not replace it with per-digit f64 operations or exact BigInt.
fn generic_integer(digits: &[u8], radix: u32) -> f64 {
    const MAX_MULTIPLIER: u32 = u32::MAX / 36;
    let mut result = 0.0;
    let mut at = 0;
    while at < digits.len() {
        let mut part = 0u32;
        let mut multiplier = 1u32;
        while at < digits.len() {
            let next_multiplier = multiplier * radix;
            if next_multiplier > MAX_MULTIPLIER {
                break;
            }
            part = part * radix + digit(digits[at]).expect("validated digits");
            multiplier = next_multiplier;
            at += 1;
        }
        result = result * f64::from(multiplier) + f64::from(part);
    }
    result
}

#[cfg(test)]
#[path = "radix_tests.rs"]
mod tests;
