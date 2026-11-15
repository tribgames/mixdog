//! The casts and number text of the hosts: `[int]`, `[int64]`, `[double]`, `[single]`, `[bool]`, `[string]` and `"$x"`,
//! `-as [int]`, `[int]::TryParse`, `[Math]::Round/Floor/Max/Min`, `'{0:X2}' -f`, and the arithmetic of the colour code
//! (`-band`, `-shr`, `+`, `*`, `/`).
//!
//! Every function returns what Windows PowerShell 5.1 produces for the value it is given, including the English text of the
//! error it throws (`Cannot convert value "abc" to type "System.Int32". Error: "Input string was not in a correct
//! format."`), since the hosts turn such an exception into the message the user sees. Numbers are written the way .NET
//! Framework writes them with the invariant culture: a `[double]` has 15 significant digits (`0.1 + 0.2` is `0.3`, `1e20` is
//! `1E+20`), a `[single]` 7, a boolean is `True` or `False`.

use super::DateKind;
use super::DateTimeValue;
use super::Decimal;
use super::Object;
use super::ObjectKind;
use super::Value;
use super::datetime;

const INT32: &str = "System.Int32";
const INT64: &str = "System.Int64";
const DOUBLE: &str = "System.Double";
const SINGLE: &str = "System.Single";
const DECIMAL: &str = "System.Decimal";

/// .NET's type name of a value, as it appears in PowerShell's conversion errors.
pub fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "System.Object",
        Value::DbNull => "System.DBNull",
        Value::Bool(_) => "System.Boolean",
        Value::Int(_) => INT32,
        Value::Long(_) => INT64,
        Value::Double(_) => DOUBLE,
        Value::Single(_) => SINGLE,
        Value::Decimal(_) => DECIMAL,
        Value::String(_) => "System.String",
        Value::DateTime(_) => "System.DateTime",
        Value::Array(_) => "System.Object[]",
        Value::Object(object) => match object.kind {
            ObjectKind::Ordered => "System.Collections.Specialized.OrderedDictionary",
            ObjectKind::Custom => "System.Management.Automation.PSCustomObject",
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// number text
// ---------------------------------------------------------------------------------------------------------------------

/// The digits and decimal exponent of a `{:e}` rendering (`d.ddde<exp>`).
fn significant_digits(formatted: &str) -> (String, i32) {
    let (mantissa, exponent) = formatted.split_once('e').unwrap_or((formatted, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    (digits, exponent.parse::<i32>().unwrap_or(0))
}

/// .NET's `G<precision>` of a finite number from its digits: fixed notation when the exponent is below the precision and
/// above -5, otherwise scientific with a sign and at least two exponent digits (`1E+20`, `1E-05`); trailing zeros removed.
fn general_from_digits(negative: bool, digits: &str, exponent: i32, precision: i32) -> String {
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if exponent >= precision || exponent <= -5 {
        out.push_str(&digits[..1]);
        if digits.len() > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('E');
        out.push(if exponent < 0 { '-' } else { '+' });
        out.push_str(&format!("{:02}", exponent.abs()));
    } else if exponent >= 0 {
        let whole = exponent as usize + 1;
        if digits.len() <= whole {
            out.push_str(digits);
            for _ in digits.len()..whole {
                out.push('0');
            }
        } else {
            out.push_str(&digits[..whole]);
            out.push('.');
            out.push_str(&digits[whole..]);
        }
    } else {
        out.push_str("0.");
        for _ in 0..(-exponent - 1) {
            out.push('0');
        }
        out.push_str(digits);
    }
    out
}

fn special_float_text(value: f64) -> Option<String> {
    if value.is_nan() {
        Some("NaN".to_string())
    } else if value.is_infinite() {
        Some(if value < 0.0 { "-Infinity" } else { "Infinity" }.to_string())
    } else if value == 0.0 {
        // .NET Framework writes a negative zero as 0.
        Some("0".to_string())
    } else {
        None
    }
}

fn general_f64(value: f64, precision: usize) -> String {
    if let Some(text) = special_float_text(value) {
        return text;
    }
    let formatted = format!("{:.*e}", precision - 1, value.abs());
    let (digits, exponent) = significant_digits(&formatted);
    general_from_digits(value < 0.0, &digits, exponent, precision as i32)
}

fn general_f32(value: f32, precision: usize) -> String {
    if let Some(text) = special_float_text(f64::from(value)) {
        return text;
    }
    let formatted = format!("{:.*e}", precision - 1, value.abs());
    let (digits, exponent) = significant_digits(&formatted);
    general_from_digits(value < 0.0, &digits, exponent, precision as i32)
}

/// `[string]$double` and `"$double"`: `Double.ToString(InvariantCulture)`, 15 significant digits.
pub fn format_double(value: f64) -> String {
    general_f64(value, 15)
}

/// `[string]$single`: `Single.ToString(InvariantCulture)`, 7 significant digits.
pub fn format_single(value: f32) -> String {
    general_f32(value, 7)
}

/// `Double.ToString("R", InvariantCulture)`, which `ConvertTo-Json` writes: 15 digits when they read back as the same
/// number, otherwise 17.
pub fn format_double_round_trip(value: f64) -> String {
    let short = general_f64(value, 15);
    if value.is_finite() && short.parse::<f64>().map(|back| back == value).unwrap_or(false) {
        return short;
    }
    general_f64(value, 17)
}

/// `Single.ToString("R", InvariantCulture)`: 7 digits when they read back as the same number, otherwise 9.
pub fn format_single_round_trip(value: f32) -> String {
    let short = general_f32(value, 7);
    if value.is_finite() && short.parse::<f32>().map(|back| back == value).unwrap_or(false) {
        return short;
    }
    general_f32(value, 9)
}

// ---------------------------------------------------------------------------------------------------------------------
// [string]
// ---------------------------------------------------------------------------------------------------------------------

/// What an element of an array or a property of a custom object looks like in the text of its container: the .NET
/// `ToString` of the raw object (an array is its type name, a custom object is empty).
fn element_text(value: &Value) -> String {
    match value {
        Value::Null | Value::DbNull => String::new(),
        Value::Array(_) => type_name(value).to_string(),
        Value::Object(object) => match object.kind {
            ObjectKind::Custom => String::new(),
            ObjectKind::Ordered => type_name(value).to_string(),
        },
        other => to_ps_string(other),
    }
}

/// `[string]$value` and `"$value"` (the invariant culture; an array is its elements joined with a space, as `$OFS` is).
pub fn to_ps_string(value: &Value) -> String {
    match value {
        Value::Null | Value::DbNull => String::new(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Int(n) => n.to_string(),
        Value::Long(n) => n.to_string(),
        Value::Double(n) => format_double(*n),
        Value::Single(n) => format_single(*n),
        Value::Decimal(n) => n.to_text(),
        Value::String(text) => text.clone(),
        Value::DateTime(date) => date_text(date.ticks),
        Value::Array(items) => items.iter().map(element_text).collect::<Vec<String>>().join(" "),
        Value::Object(object) => match object.kind {
            ObjectKind::Ordered => type_name(value).to_string(),
            ObjectKind::Custom => custom_object_text(object),
        },
    }
}

/// A `[DateTime]` as `[string]` writes it: `MM/dd/yyyy HH:mm:ss` of the invariant culture.
fn date_text(ticks: i64) -> String {
    let civil = datetime::civil_from_ticks(ticks);
    format!("{:02}/{:02}/{:04} {:02}:{:02}:{:02}", civil.month, civil.day, civil.year, civil.hour, civil.minute, civil.second)
}

/// A `PSCustomObject` as text: `@{a=1; b=two}`.
pub fn custom_object_text(object: &Object) -> String {
    let pairs: Vec<String> = object.entries.iter().map(|(name, value)| format!("{name}={}", element_text(value))).collect();
    format!("@{{{}}}", pairs.join("; "))
}

// ---------------------------------------------------------------------------------------------------------------------
// numeric casts
// ---------------------------------------------------------------------------------------------------------------------

const FORMAT_ERROR: &str = "Input string was not in a correct format.";

fn cannot_convert_value(value: &Value, target: &str, reason: &str) -> String {
    format!("Cannot convert value \"{}\" to type \"{target}\". Error: \"{reason}\"", to_ps_string(value))
}

/// The value as the "Cannot convert the ..." message quotes it: an array by its type name (not its elements).
fn shown_value(value: &Value) -> String {
    match value {
        Value::Array(_) => type_name(value).to_string(),
        other => to_ps_string(other),
    }
}

fn cannot_convert_the(value: &Value, target: &str) -> String {
    format!(
        "Cannot convert the \"{}\" value of type \"{}\" to type \"{target}\".",
        shown_value(value),
        type_name(value)
    )
}

fn dbnull_error(value: &Value, target: &str) -> String {
    cannot_convert_value(value, target, "Object cannot be cast from DBNull to other types.")
}

fn date_error(value: &Value, target: &str) -> String {
    let short = target.trim_start_matches("System.");
    cannot_convert_value(value, target, &format!("Invalid cast from 'DateTime' to '{short}'."))
}

/// The text of the overflow of a conversion from a double (`Convert.ToInt32(double)` and `Convert.ToInt64(double)` differ).
fn double_overflow_reason(bits: u32) -> &'static str {
    if bits == 32 { "Value was either too large or too small for an Int32." } else { "Arithmetic operation resulted in an overflow." }
}

fn whole_overflow_reason(bits: u32) -> &'static str {
    if bits == 32 { "Value was either too large or too small for an Int32." } else { "Value was either too large or too small for an Int64." }
}

/// `Math.Round(x)`: to the nearest integer, halves to even.
pub fn round_half_even(value: f64) -> f64 {
    let floor = value.floor();
    let diff = value - floor;
    if diff < 0.5 {
        floor
    } else if diff > 0.5 {
        floor + 1.0
    } else if floor % 2.0 == 0.0 {
        floor
    } else {
        floor + 1.0
    }
}

/// The whole number a `[double]` converts to for an integral target, `None` out of range.
fn double_to_whole(value: f64, bits: u32) -> Option<i64> {
    if value.is_nan() {
        return None;
    }
    let (min, max) = if bits == 32 { (-2_147_483_648.0, 2_147_483_648.0) } else { (-9_223_372_036_854_775_808.0, 9_223_372_036_854_775_808.0) };
    let rounded = round_half_even(value);
    if rounded >= min && rounded < max { Some(rounded as i64) } else { None }
}

/// `String.Trim()`: every Unicode white space.
fn trim_text(text: &str) -> &str {
    text.trim_matches(char::is_whitespace)
}

/// The sign and the rest of a numeric text.
fn split_sign(text: &str) -> (bool, &str) {
    match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    }
}

/// A floating-point text as `Double.Parse(NumberStyles.Float | AllowThousands, InvariantCulture)` reads it: an optional
/// sign, digits with thousands commas, a fraction, an exponent; `NaN`, `Infinity` and `-Infinity`. `None` for anything else
/// (an overflowing number is `Err`).
fn parse_float_text(text: &str) -> Result<Option<f64>, ()> {
    match text {
        "NaN" => return Ok(Some(f64::NAN)),
        "Infinity" => return Ok(Some(f64::INFINITY)),
        "-Infinity" => return Ok(Some(f64::NEG_INFINITY)),
        _ => {}
    }
    let (negative, unsigned) = split_sign(text);
    let mut clean = String::new();
    let mut seen_digit = false;
    let mut seen_point = false;
    let mut exponent_at = None;
    for (index, c) in unsigned.char_indices() {
        match c {
            '0'..='9' => {
                seen_digit = true;
                clean.push(c);
            }
            ',' if seen_digit && !seen_point => {}
            '.' if !seen_point => {
                seen_point = true;
                clean.push('.');
            }
            'e' | 'E' if seen_digit => {
                exponent_at = Some(index);
                break;
            }
            _ => return Ok(None),
        }
    }
    if !seen_digit {
        return Ok(None);
    }
    if let Some(at) = exponent_at {
        let (exp_negative, exp_digits) = split_sign(&unsigned[at + 1..]);
        if exp_digits.is_empty() || !exp_digits.chars().all(|c| c.is_ascii_digit()) {
            return Ok(None);
        }
        clean.push('e');
        if exp_negative {
            clean.push('-');
        }
        clean.push_str(exp_digits);
    }
    let value = match clean.parse::<f64>() {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if value.is_infinite() {
        return Err(());
    }
    // .NET Framework reads -0 as 0.
    let value = if value == 0.0 { 0.0 } else { value };
    Ok(Some(if negative { -value } else { value }))
}

/// A hexadecimal text (after `0x`) as `Convert.ToInt32(text, 16)` / `Convert.ToInt64(text, 16)` reads it: the value
/// wraps to the signed type.
fn parse_hex_text(hex: &str, bits: u32) -> Result<i64, String> {
    if hex.is_empty() {
        return Err("Index was out of range. Must be non-negative and less than the size of the collection.\r\nParameter name: startIndex".to_string());
    }
    let mut chars = hex.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_hexdigit()) {
        return Err("Could not find any recognizable digits.".to_string());
    }
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Additional non-parsable characters are at the end of the string.".to_string());
    }
    let overflow = || whole_overflow_reason(bits).to_string();
    let value = u128::from_str_radix(hex, 16).map_err(|_| overflow())?;
    if bits == 32 {
        if value > u128::from(u32::MAX) {
            return Err(overflow());
        }
        Ok(i64::from(value as u32 as i32))
    } else {
        if value > u128::from(u64::MAX) {
            return Err(overflow());
        }
        Ok(value as u64 as i64)
    }
}

/// A string cast to a whole number of `bits` bits, as PowerShell converts it.
fn string_to_whole(text: &str, bits: u32, value: &Value) -> Result<i64, String> {
    let target = if bits == 32 { INT32 } else { INT64 };
    let fail = |reason: &str| cannot_convert_value(value, target, reason);
    if text.is_empty() {
        return Ok(0);
    }
    let trimmed = trim_text(text);
    if trimmed.is_empty() {
        return Err(fail("Index was outside the bounds of the array."));
    }
    if let Some(hex) = trimmed.strip_prefix("0x").or_else(|| trimmed.strip_prefix("0X")) {
        return parse_hex_text(hex, bits).map_err(|reason| fail(&reason));
    }
    let (negative, unsigned) = split_sign(trimmed);
    // Digits with thousands commas are an integer; a point or an exponent sends the text through a double.
    let integral = !unsigned.is_empty()
        && unsigned.chars().next().is_some_and(|c| c.is_ascii_digit())
        && unsigned.chars().all(|c| c.is_ascii_digit() || c == ',');
    if integral {
        let digits: String = unsigned.chars().filter(char::is_ascii_digit).collect();
        let magnitude = match digits.parse::<i128>() {
            Ok(n) => n,
            Err(_) => return Err(fail(whole_overflow_reason(bits))),
        };
        let signed = if negative { -magnitude } else { magnitude };
        let fits = if bits == 32 { i32::try_from(signed).map(i64::from).ok() } else { i64::try_from(signed).ok() };
        return fits.ok_or_else(|| fail(whole_overflow_reason(bits)));
    }
    if unsigned.contains(['.', 'e', 'E']) {
        if let Ok(Some(number)) = parse_float_text(trimmed) {
            if let Some(whole) = double_to_whole(number, bits) {
                return Ok(whole);
            }
        }
    }
    Err(fail(FORMAT_ERROR))
}

/// A cast to a whole number of `bits` bits.
fn cast_whole(value: &Value, bits: u32) -> Result<i64, String> {
    let target = if bits == 32 { INT32 } else { INT64 };
    match value {
        Value::Null => Ok(0),
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Int(n) => Ok(i64::from(*n)),
        Value::Long(n) => {
            if bits == 32 {
                i32::try_from(*n).map(i64::from).map_err(|_| cannot_convert_value(value, target, whole_overflow_reason(32)))
            } else {
                Ok(*n)
            }
        }
        Value::Double(n) => double_to_whole(*n, bits).ok_or_else(|| cannot_convert_value(value, target, double_overflow_reason(bits))),
        Value::Single(n) => {
            double_to_whole(f64::from(*n), bits).ok_or_else(|| cannot_convert_value(value, target, double_overflow_reason(bits)))
        }
        Value::Decimal(n) => {
            let whole = n.round_to_i128();
            let fits = whole.and_then(|w| if bits == 32 { i32::try_from(w).map(i64::from).ok() } else { i64::try_from(w).ok() });
            fits.ok_or_else(|| cannot_convert_value(value, target, whole_overflow_reason(bits)))
        }
        Value::String(text) => string_to_whole(text, bits, value),
        Value::DbNull => Err(dbnull_error(value, target)),
        Value::DateTime(_) => Err(date_error(value, target)),
        Value::Array(_) | Value::Object(_) => Err(cannot_convert_the(value, target)),
    }
}

/// `[int]$value`.
pub fn to_int(value: &Value) -> Result<i32, String> {
    cast_whole(value, 32).map(|n| n as i32)
}

/// `[int64]$value`.
pub fn to_int64(value: &Value) -> Result<i64, String> {
    cast_whole(value, 64)
}

/// `[double]$value`.
pub fn to_double(value: &Value) -> Result<f64, String> {
    match value {
        Value::Null => Ok(0.0),
        Value::Bool(flag) => Ok(if *flag { 1.0 } else { 0.0 }),
        Value::Int(n) => Ok(f64::from(*n)),
        Value::Long(n) => Ok(*n as f64),
        Value::Double(n) => Ok(*n),
        Value::Single(n) => Ok(f64::from(*n)),
        Value::Decimal(n) => Ok(n.to_f64()),
        Value::String(text) => {
            if text.is_empty() {
                return Ok(0.0);
            }
            match parse_float_text(trim_text(text)) {
                Ok(Some(number)) => Ok(number),
                Ok(None) => Err(cannot_convert_value(value, DOUBLE, FORMAT_ERROR)),
                Err(()) => Err(cannot_convert_value(value, DOUBLE, "Value was either too large or too small for a Double.")),
            }
        }
        Value::DbNull => Err(dbnull_error(value, DOUBLE)),
        Value::DateTime(_) => Err(date_error(value, DOUBLE)),
        Value::Array(_) | Value::Object(_) => Err(cannot_convert_the(value, DOUBLE)),
    }
}

/// `[single]$value`.
pub fn to_single(value: &Value) -> Result<f32, String> {
    match value {
        Value::Null => Ok(0.0),
        Value::Bool(flag) => Ok(if *flag { 1.0 } else { 0.0 }),
        Value::Int(n) => Ok(*n as f32),
        Value::Long(n) => Ok(*n as f32),
        Value::Double(n) => Ok(*n as f32),
        Value::Single(n) => Ok(*n),
        Value::Decimal(n) => Ok(n.to_f64() as f32),
        Value::String(text) => {
            if text.is_empty() {
                return Ok(0.0);
            }
            let trimmed = trim_text(text);
            match parse_float_text(trimmed) {
                Ok(Some(number)) => {
                    // Parse the cleaned digits as a single, not as a double rounded again.
                    let direct = trimmed.replace(',', "").parse::<f32>().unwrap_or(number as f32);
                    if direct.is_infinite() && !number.is_infinite() {
                        Err(cannot_convert_value(value, SINGLE, "Value was either too large or too small for a Single."))
                    } else {
                        Ok(if direct == 0.0 { 0.0 } else { direct })
                    }
                }
                Ok(None) => Err(cannot_convert_value(value, SINGLE, FORMAT_ERROR)),
                Err(()) => Err(cannot_convert_value(value, SINGLE, "Value was either too large or too small for a Single.")),
            }
        }
        Value::DbNull => Err(dbnull_error(value, SINGLE)),
        Value::DateTime(_) => Err(date_error(value, SINGLE)),
        Value::Array(_) | Value::Object(_) => Err(cannot_convert_the(value, SINGLE)),
    }
}

/// `[bool]$value`: `$null`, `0`, `0.0`, `''`, `$false` and an empty array are false; a one-element array is the truth of
/// its element; everything else (a non-empty string such as `'false'`, a COM `VARIANT_BOOL` of -1) is true.
pub fn to_bool(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Int(n) => *n != 0,
        Value::Long(n) => *n != 0,
        Value::Double(n) => *n != 0.0,
        Value::Single(n) => *n != 0.0,
        Value::Decimal(n) => !n.is_zero(),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => match items.len() {
            0 => false,
            1 => to_bool(&items[0]),
            _ => true,
        },
        Value::DbNull | Value::DateTime(_) | Value::Object(_) => true,
    }
}

/// `$value -as [int]`: the cast, or `None` where it would throw.
pub fn as_int(value: &Value) -> Option<i32> {
    to_int(value).ok()
}

/// `[int]::TryParse($text, [ref]$number)`: white space around, an optional sign, digits; nothing else.
pub fn try_parse_int(text: &str) -> Option<i32> {
    let is_white = |c: char| matches!(c, ' ' | '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r');
    let trimmed = text.trim_matches(is_white);
    let (negative, digits) = split_sign(trimmed);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let magnitude: i64 = digits.parse().ok()?;
    i32::try_from(if negative { -magnitude } else { magnitude }).ok()
}

// ---------------------------------------------------------------------------------------------------------------------
// [Math]
// ---------------------------------------------------------------------------------------------------------------------

/// `[Math]::Round($x, $digits)` (.NET Framework scales by a power of ten, rounds to even and scales back).
pub fn round_digits(value: f64, digits: i32) -> Result<f64, String> {
    if !(0..=15).contains(&digits) {
        return Err(
            "Exception calling \"Round\" with \"2\" argument(s): \"Rounding digits must be between 0 and 15, inclusive.\r\nParameter name: digits\""
                .to_string(),
        );
    }
    if value.abs() >= 1e16 || !value.is_finite() {
        return Ok(value);
    }
    let power = 10f64.powi(digits);
    Ok(round_half_even(value * power) / power)
}

/// `[Math]::Round([double]$x)`.
pub fn round(value: f64) -> f64 {
    round_half_even(value)
}

/// The text PowerShell gives a [Math] argument it cannot convert.
fn argument_error(name: &str, method: &str, value: &Value, target: &str, inner: &str) -> String {
    format!("Cannot convert argument \"{name}\", with value: \"{}\", for \"{method}\" to type \"{target}\": \"{inner}\"", to_ps_string(value))
}

/// `[Math]::Floor($x)`: an `[int]` or `[int64]` binds the Decimal overload, a string or `$null` the Double one.
pub fn floor(value: &Value) -> Result<Value, String> {
    match value {
        Value::Int(n) => Ok(Value::Decimal(decimal_from_whole(i64::from(*n)))),
        Value::Long(n) => Ok(Value::Decimal(decimal_from_whole(*n))),
        Value::Decimal(n) => Ok(Value::Decimal(decimal_floor(n))),
        Value::Double(n) => Ok(Value::Double(n.floor())),
        Value::Single(n) => Ok(Value::Double(f64::from(*n).floor())),
        Value::Null => Ok(Value::Double(0.0)),
        Value::String(_) | Value::DbNull => match to_double(value) {
            Ok(number) => Ok(Value::Double(number.floor())),
            Err(inner) => Err(argument_error("d", "Floor", value, DOUBLE, &inner)),
        },
        Value::Bool(_) => Err("Multiple ambiguous overloads found for \"Floor\" and the argument count: \"1\".".to_string()),
        Value::DateTime(_) | Value::Array(_) | Value::Object(_) => {
            Err("Cannot find an overload for \"Floor\" and the argument count: \"1\".".to_string())
        }
    }
}

fn decimal_from_whole(whole: i64) -> Decimal {
    Decimal { negative: whole < 0, mantissa: u128::from(whole.unsigned_abs()), scale: 0 }
}

fn decimal_floor(value: &Decimal) -> Decimal {
    let Some(power) = 10u128.checked_pow(u32::from(value.scale)) else {
        return *value;
    };
    let whole = value.mantissa / power;
    let exact = value.mantissa % power == 0;
    let mantissa = if value.negative && !exact { whole + 1 } else { whole };
    Decimal { negative: value.negative && mantissa != 0, mantissa, scale: 0 }
}

/// A `[double]` as a `[decimal]` (`new Decimal(double)`: 15 significant digits, no trailing zeros).
fn decimal_from_double(value: f64) -> Result<Decimal, String> {
    let overflow = || cannot_convert_value(&Value::Double(value), DECIMAL, "Value was either too large or too small for a Decimal.");
    if value.is_nan() || value.is_infinite() || value.abs() >= 7.9228162514264338e28 {
        return Err(overflow());
    }
    if value == 0.0 || value.abs() < 1e-28 {
        return Ok(Decimal { negative: false, mantissa: 0, scale: 0 });
    }
    let formatted = format!("{:.14e}", value.abs());
    let (digits, exponent) = significant_digits(&formatted);
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    // digits d1 d2 ... with the point after the first: value = 0.d1d2... * 10^(exponent + 1)
    let mut mantissa_text = digits.to_string();
    let mut scale = digits.len() as i32 - 1 - exponent;
    while scale < 0 {
        mantissa_text.push('0');
        scale += 1;
    }
    while scale > 28 {
        mantissa_text.pop();
        scale -= 1;
    }
    let mantissa = mantissa_text.parse::<u128>().map_err(|_| overflow())?;
    Ok(Decimal { negative: value < 0.0, mantissa, scale: scale as u8 })
}

/// A value as the argument of a Decimal overload.
fn to_decimal(value: &Value) -> Result<Decimal, String> {
    match value {
        Value::Decimal(n) => Ok(*n),
        Value::Int(n) => Ok(decimal_from_whole(i64::from(*n))),
        Value::Long(n) => Ok(decimal_from_whole(*n)),
        Value::Bool(flag) => Ok(decimal_from_whole(i64::from(*flag))),
        Value::Null => Ok(decimal_from_whole(0)),
        Value::Double(n) => decimal_from_double(*n),
        Value::Single(n) => decimal_from_double(format_single(*n).parse::<f64>().unwrap_or(f64::from(*n))),
        Value::String(text) => match Decimal::parse(trim_text(text)) {
            Some(number) => Ok(number),
            None => Err(cannot_convert_value(value, DECIMAL, FORMAT_ERROR)),
        },
        other => Err(cannot_convert_the(other, DECIMAL)),
    }
}

/// The numeric type of an argument, if it has one.
fn numeric_type(value: &Value) -> Option<&'static str> {
    match value {
        Value::Int(_) => Some(INT32),
        Value::Long(_) => Some(INT64),
        Value::Single(_) => Some(SINGLE),
        Value::Double(_) => Some(DOUBLE),
        Value::Decimal(_) => Some(DECIMAL),
        _ => None,
    }
}

/// `[Math]::Max($a, $b)`: PowerShell binds the overload of the first argument's numeric type (two `[int]` stay `[int]`; an
/// `[int]` and a `[double]` give an `[int]` that rounds the fraction); when the first argument is a string, `$null` or a
/// boolean the second argument's type decides, and `[double]` when neither is numeric.
pub fn max(a: &Value, b: &Value) -> Result<Value, String> {
    extreme(a, b, true)
}

/// See [`max`].
pub fn min(a: &Value, b: &Value) -> Result<Value, String> {
    extreme(a, b, false)
}

fn extreme(a: &Value, b: &Value, larger: bool) -> Result<Value, String> {
    let method = if larger { "Max" } else { "Min" };
    if matches!((a, b), (Value::Bool(_), Value::Bool(_))) {
        return Err(format!("Multiple ambiguous overloads found for \"{method}\" and the argument count: \"2\"."));
    }
    for value in [a, b] {
        if matches!(value, Value::DateTime(_) | Value::Array(_) | Value::Object(_)) {
            return Err(format!("Cannot find an overload for \"{method}\" and the argument count: \"2\"."));
        }
    }
    let target = numeric_type(a).or_else(|| numeric_type(b)).unwrap_or(DOUBLE);
    let convert = |value: &Value, name: &str| -> Result<Value, String> {
        let wrap = |inner: String| argument_error(name, method, value, target, &inner);
        match target {
            INT32 => to_int(value).map(Value::Int).map_err(wrap),
            INT64 => to_int64(value).map(Value::Long).map_err(wrap),
            SINGLE => to_single(value).map(Value::Single).map_err(wrap),
            DECIMAL => to_decimal(value).map(Value::Decimal).map_err(wrap),
            _ => to_double(value).map(Value::Double).map_err(wrap),
        }
    };
    let (x, y) = (convert(a, "val1")?, convert(b, "val2")?);
    if let (Value::Int(p), Value::Int(q)) = (&x, &y) {
        return Ok(Value::Int(if larger { *p.max(q) } else { *p.min(q) }));
    }
    if let (Value::Long(p), Value::Long(q)) = (&x, &y) {
        return Ok(Value::Long(if larger { *p.max(q) } else { *p.min(q) }));
    }
    if let (Value::Single(p), Value::Single(q)) = (&x, &y) {
        return Ok(Value::Single(float_extreme(f64::from(*p), f64::from(*q), larger) as f32));
    }
    if let (Value::Double(p), Value::Double(q)) = (&x, &y) {
        return Ok(Value::Double(float_extreme(*p, *q, larger)));
    }
    let order = super::collate::compare_values(&x, &y);
    let first = if larger { order != std::cmp::Ordering::Less } else { order != std::cmp::Ordering::Greater };
    Ok(if first { x } else { y })
}

/// `Math.Max/Min(double, double)`: a NaN wins.
fn float_extreme(x: f64, y: f64, larger: bool) -> f64 {
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if larger {
        if x > y { x } else { y }
    } else if x < y {
        x
    } else {
        y
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// -f, colours, arithmetic
// ---------------------------------------------------------------------------------------------------------------------

/// `'{0:X2}' -f $value`: upper-case hexadecimal, at least two digits; a negative integer shows its two's complement. A
/// string, `$null` or boolean is written as it is (`'{0:X2}' -f 'x'` is `x`); a floating-point or decimal number is refused.
pub fn format_x2(value: &Value) -> Result<String, String> {
    match value {
        Value::Int(n) => Ok(format!("{:02X}", *n as u32)),
        Value::Long(n) => Ok(format!("{:02X}", *n as u64)),
        Value::Double(_) | Value::Single(_) | Value::Decimal(_) => Err("Error formatting a string: Format specifier was invalid..".to_string()),
        other => Ok(to_ps_string(other)),
    }
}

/// `Convert.ToInt32($pair, 16)` of the two characters `Color-Value` cuts out.
fn hex_pair(pair: &[u16]) -> Result<i32, &'static str> {
    let digit = |unit: u16| char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(16));
    let (first, second) = (pair[0], pair[1]);
    if first == u16::from(b'-') {
        return Err("String cannot contain a minus sign if the base is not 10.");
    }
    if first == u16::from(b'+') {
        return match digit(second) {
            Some(n) => Ok(n as i32),
            None => Err("Could not find any recognizable digits."),
        };
    }
    let (Some(high), second_digit) = (digit(first), digit(second)) else {
        // The prefix 0x with nothing after it, a space, a non-hex letter.
        return Err("Could not find any recognizable digits.");
    };
    if first == u16::from(b'0') && (second == u16::from(b'x') || second == u16::from(b'X')) {
        return Err("Could not find any recognizable digits.");
    }
    match second_digit {
        Some(low) => Ok((high * 16 + low) as i32),
        None => Err("Additional non-parsable characters are at the end of the string."),
    }
}

/// `Color-Value`: `RRGGBB` (a leading `#` allowed) to the BGR integer Office uses.
pub fn color_value(hex: &str) -> Result<i32, String> {
    let clean: Vec<u16> = hex.trim_start_matches('#').encode_utf16().collect();
    if clean.len() != 6 {
        return Err(format!("Invalid color '{hex}'; expected RRGGBB"));
    }
    let part = |from: usize| -> Result<i32, String> {
        hex_pair(&clean[from..from + 2]).map_err(|reason| format!("Exception calling \"ToInt32\" with \"2\" argument(s): \"{reason}\""))
    };
    let (r, g, b) = (part(0)?, part(2)?, part(4)?);
    Ok(r + 256 * g + 65536 * b)
}

/// `Color-Hex`: the BGR integer as `RRGGBB`.
pub fn color_hex(color: i64) -> String {
    let r = color & 255;
    let g = (color >> 8) & 255;
    let b = (color >> 16) & 255;
    format!("{r:02X}{g:02X}{b:02X}")
}

/// `Color-Hex $value`: the parameter is `[long]`, so the argument is cast first and a refusal says so.
pub fn color_hex_of(value: &Value) -> Result<String, String> {
    match to_int64(value) {
        Ok(color) => Ok(color_hex(color)),
        Err(inner) => Err(format!("Cannot process argument transformation on parameter 'color'. {inner}")),
    }
}

fn arithmetic_operand(value: &Value) -> Result<Value, String> {
    match value {
        Value::Int(_) | Value::Long(_) | Value::Double(_) => Ok(value.clone()),
        other => Err(cannot_convert_the(other, DOUBLE)),
    }
}

fn whole_of(value: &Value) -> Option<i64> {
    match value {
        Value::Int(n) => Some(i64::from(*n)),
        Value::Long(n) => Some(*n),
        _ => None,
    }
}

/// `$a + $b`, `$a - $b`, `$a * $b` over `[int]`, `[int64]` and `[double]`: two integers give an integer of the wider type,
/// and a result that does not fit becomes a `[double]`.
pub fn arithmetic(op: char, a: &Value, b: &Value) -> Result<Value, String> {
    let (a, b) = (arithmetic_operand(a)?, arithmetic_operand(b)?);
    if let (Some(x), Some(y)) = (whole_of(&a), whole_of(&b)) {
        let exact = match op {
            '+' => x.checked_add(y),
            '-' => x.checked_sub(y),
            _ => x.checked_mul(y),
        };
        let both_int = matches!((&a, &b), (Value::Int(_), Value::Int(_)));
        return Ok(match exact {
            Some(n) if both_int => match i32::try_from(n) {
                Ok(small) => Value::Int(small),
                Err(_) => Value::Double(n as f64),
            },
            Some(n) => Value::Long(n),
            None if op == '*' => Value::Double(truncated_f64(i128::from(x) * i128::from(y))),
            None => Value::Double(float_arithmetic(op, x as f64, y as f64)),
        });
    }
    Ok(Value::Double(float_arithmetic(op, to_double(&a)?, to_double(&b)?)))
}

/// A whole number as a `[double]` cut toward zero, which is what the product of two integers that overflows becomes in
/// Windows PowerShell 5.1 (it is computed as a decimal and converted without rounding to nearest).
fn truncated_f64(n: i128) -> f64 {
    let nearest = n as f64;
    if (nearest as i128).unsigned_abs() > n.unsigned_abs() {
        f64::from_bits(nearest.to_bits() - 1)
    } else {
        nearest
    }
}

fn float_arithmetic(op: char, x: f64, y: f64) -> f64 {
    match op {
        '+' => x + y,
        '-' => x - y,
        _ => x * y,
    }
}

/// `$a / $b`: an exact integer quotient stays an integer, anything else is a `[double]`; dividing two integers by zero
/// throws, a division with a `[double]` follows IEEE.
pub fn divide(a: &Value, b: &Value) -> Result<Value, String> {
    let (a, b) = (arithmetic_operand(a)?, arithmetic_operand(b)?);
    if let (Some(x), Some(y)) = (whole_of(&a), whole_of(&b)) {
        if y == 0 {
            return Err("Attempted to divide by zero.".to_string());
        }
        let both_int = matches!((&a, &b), (Value::Int(_), Value::Int(_)));
        if x.checked_rem(y) == Some(0) {
            return Ok(match x.checked_div(y) {
                Some(quotient) if both_int => match i32::try_from(quotient) {
                    Ok(small) => Value::Int(small),
                    Err(_) => Value::Double(quotient as f64),
                },
                Some(quotient) => Value::Long(quotient),
                None => Value::Double(x as f64 / y as f64),
            });
        }
        return Ok(Value::Double(x as f64 / y as f64));
    }
    Ok(Value::Double(to_double(&a)? / to_double(&b)?))
}

/// `$a -gt $b`: false when either side is a NaN.
pub fn greater_than(a: &Value, b: &Value) -> bool {
    super::collate::compare_partial(a, b) == Some(std::cmp::Ordering::Greater)
}

/// `$a -eq $b`: numbers numerically, strings case-insensitively by culture, `$null` only equal to `$null`; a NaN is equal
/// to nothing.
pub fn equals(a: &Value, b: &Value) -> bool {
    super::collate::compare_partial(a, b) == Some(std::cmp::Ordering::Equal)
}

/// `$a -ceq $b` for strings: the culture comparison without ignoring case (canonically equal texts are equal).
pub fn equals_case_sensitive(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => super::collate::compare_strings_case_sensitive(x, y) == std::cmp::Ordering::Equal,
        _ => equals(a, b),
    }
}

/// A `[DateTime]` read from a COM date: `Kind` `Unspecified`.
pub fn unspecified_date(ticks: i64) -> Value {
    Value::DateTime(DateTimeValue { ticks, kind: DateKind::Unspecified })
}
