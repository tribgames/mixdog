//! A request line as `ConvertFrom-Json` of Windows PowerShell 5.1 reads it, and the property reads the hosts make on it.
//!
//! Windows PowerShell 5.1 parses with `System.Web.Script.Serialization.JavaScriptSerializer` and then turns every
//! dictionary into a `PSCustomObject` and every list into an `object[]`. Both steps show in what the hosts do with a
//! request: integers arrive as `Int32` or `Int64`, a number with a fraction as `Decimal` (a `Double` only when it has an
//! exponent or does not fit a decimal), `\/Date(ms)\/` strings as `DateTime`, single-quoted strings and bare words as
//! names are accepted, a trailing comma in an object is an error, nesting beyond 102 levels is an error, and two keys that
//! differ only by case are refused. The error texts are those of the English .NET Framework resources, the language the
//! hosts run in (the recorded corpus is the reference). A missing property reads as `$null`.
//!
//! Strings are handled as UTF-16 units, as .NET does: error positions count units and an unpaired surrogate (which a
//! Rust `String` cannot hold) is replaced by U+FFFD when the text is read back.

use super::DateKind;
use super::DateTimeValue;
use super::Decimal;
use super::Object;
use super::ObjectKind;
use super::Value;

/// The deepest nesting JavaScriptSerializer accepts as `ConvertFrom-Json` sets it up: a primitive counts as a level.
const DEPTH_LIMIT: usize = 102;
/// `DateTime.MaxValue.Ticks`.
const MAX_DATE_TICKS: i64 = 3_155_378_975_999_999_999;
/// The ticks of 1970-01-01.
const EPOCH_TICKS: i64 = 621_355_968_000_000_000;

const ERR_EMPTY_NAME: &str =
    "Cannot process argument because the value of argument \"name\" is not valid. Change the value of the \"name\" argument and run the operation again.";
const ERR_OBJECT: &str = "Invalid object passed in, ':' or '}' expected.";

/// `-eq` / property-name comparison of PowerShell: ordinal, ignoring case (a character's simple upper-case form).
pub fn names_equal(a: &str, b: &str) -> bool {
    let mut left = a.chars();
    let mut right = b.chars();
    loop {
        match (left.next(), right.next()) {
            (None, None) => return true,
            (Some(x), Some(y)) => {
                if x != y && fold(x) != fold(y) {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

fn fold(c: char) -> char {
    let mut upper = c.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(single), None) => single,
        _ => c,
    }
}

/// `$text | ConvertFrom-Json`: the value, or the message of the error PowerShell raises. An empty text and `null` are `$null`.
pub fn parse_payload(text: &str) -> Result<Value, String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut parser = Parser { units: &units, index: 0 };
    let raw = parser.deserialize(0)?;
    if parser.next_non_empty().is_some() {
        return Err(primitive_error(&parser.rest()));
    }
    match raw {
        None => Ok(Value::Null),
        Some(raw) => convert(raw),
    }
}

/// `$payload.name`: the value of the property of that name in any case, `$null` if there is none (or `$payload` is not an
/// object: the hosts read only objects).
pub fn property(value: &Value, name: &str) -> Value {
    match value {
        Value::Object(object) => object.get(name).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// `Operation-Property $op $name $fallback` of `office-com-host.ps1`: the operation's own property when it holds a value,
/// else the one of its `properties` object, else the fallback.
pub fn operation_property(op: &Value, name: &str, fallback: Value) -> Value {
    if let Value::Object(object) = op {
        if let Some(direct) = object.get(name) {
            if !direct.is_null() {
                return direct.clone();
            }
        }
        if let Some(Value::Object(properties)) = object.get("properties") {
            if let Some(nested) = properties.get(name) {
                if !nested.is_null() {
                    return nested.clone();
                }
            }
        }
    }
    fallback
}

// ---- what JavaScriptSerializer returns ------------------------------------------------------------------------------

enum Raw {
    Scalar(Value),
    List(Vec<Raw>),
    /// A dictionary with case-sensitive keys, in the order they were first set.
    Dict(Vec<(String, Raw)>),
}

/// PowerShell's own step: dictionaries become objects (empty names and names equal but for case are refused), lists arrays.
fn convert(raw: Raw) -> Result<Value, String> {
    match raw {
        Raw::Scalar(value) => Ok(value),
        Raw::List(items) => items.into_iter().map(convert).collect::<Result<Vec<Value>, String>>().map(Value::Array),
        Raw::Dict(entries) => {
            let mut object = Object::new(ObjectKind::Custom);
            for (key, item) in entries {
                if key.is_empty() {
                    return Err(ERR_EMPTY_NAME.to_string());
                }
                if let Some((earlier, _)) = object.entries.iter().find(|(name, _)| names_equal(name, &key)) {
                    return Err(format!(
                        "Cannot convert the JSON string because a dictionary that was converted from the string contains the duplicated keys '{earlier}' and '{key}'."
                    ));
                }
                let value = convert(item)?;
                object.entries.push((key, value));
            }
            Ok(Value::Object(object))
        }
    }
}

// ---- JavaScriptObjectDeserializer -----------------------------------------------------------------------------------

struct Parser<'a> {
    units: &'a [u16],
    index: usize,
}

fn primitive_error(token: &str) -> String {
    format!("Invalid JSON primitive: {token}.")
}

fn is_white_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(char::is_whitespace)
}

/// `Char.IsLetterOrDigit` of one UTF-16 unit (a surrogate half is neither).
fn is_letter_or_digit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(char::is_alphanumeric)
}

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn is(unit: u16, ascii: u8) -> bool {
    unit == u16::from(ascii)
}

impl Parser<'_> {
    fn move_next(&mut self) -> Option<u16> {
        let unit = self.units.get(self.index).copied();
        if unit.is_some() {
            self.index += 1;
        }
        unit
    }

    fn move_prev(&mut self) {
        self.index = self.index.saturating_sub(1);
    }

    fn next_non_empty(&mut self) -> Option<u16> {
        while let Some(unit) = self.move_next() {
            if !is_white_space(unit) {
                return Some(unit);
            }
        }
        None
    }

    fn rest(&self) -> String {
        lossy(&self.units[self.index.min(self.units.len())..])
    }

    /// `JavaScriptString.GetDebugString`: the message, the position and the whole input.
    fn debug(&self, message: &str) -> String {
        format!("{message} ({}): {}", self.index, lossy(self.units))
    }

    fn starts_with_here(&self, prefix: &str) -> bool {
        let wanted: Vec<u16> = prefix.encode_utf16().collect();
        self.units.get(self.index..self.index + wanted.len()).is_some_and(|got| got == wanted.as_slice())
    }

    fn deserialize(&mut self, depth: usize) -> Result<Option<Raw>, String> {
        let depth = depth + 1;
        if depth > DEPTH_LIMIT {
            return Err(self.debug("RecursionLimit exceeded."));
        }
        let Some(first) = self.next_non_empty() else { return Ok(None) };
        self.move_prev();
        if is(first, b'{') {
            return self.dictionary(depth).map(Some);
        }
        if is(first, b'[') {
            return self.list(depth).map(Some);
        }
        if is(first, b'"') || is(first, b'\'') {
            let dated = self.starts_with_here("\"\\/Date(");
            let text = lossy(&self.string()?);
            return Ok(Some(Raw::Scalar(if dated { date_or_text(text)? } else { Value::String(text) })));
        }
        self.primitive().map(|value| Some(Raw::Scalar(value)))
    }

    fn element(&mut self, depth: usize) -> Result<Raw, String> {
        Ok(self.deserialize(depth)?.unwrap_or(Raw::Scalar(Value::Null)))
    }

    fn list(&mut self, depth: usize) -> Result<Raw, String> {
        self.move_next();
        let mut items = Vec::new();
        let mut expect_more = false;
        let mut last = None;
        while let Some(c) = self.next_non_empty() {
            last = Some(c);
            if is(c, b']') {
                break;
            }
            self.move_prev();
            items.push(self.element(depth)?);
            let after = self.next_non_empty();
            last = after;
            match after {
                Some(c) if is(c, b']') => {
                    expect_more = false;
                    break;
                }
                Some(c) if is(c, b',') => expect_more = true,
                _ => return Err(self.debug("Invalid array passed in, ',' expected.")),
            }
        }
        if expect_more {
            return Err(self.debug("Invalid array passed in, extra trailing ','."));
        }
        if !last.is_some_and(|c| is(c, b']')) {
            return Err(self.debug("Invalid array passed in, ']' expected."));
        }
        Ok(Raw::List(items))
    }

    fn dictionary(&mut self, depth: usize) -> Result<Raw, String> {
        self.move_next();
        let mut entries: Vec<(String, Raw)> = Vec::new();
        let mut first = true;
        loop {
            let Some(c) = self.next_non_empty() else { return Err(self.debug(ERR_OBJECT)) };
            if is(c, b'}') {
                if first {
                    return Ok(Raw::Dict(entries));
                }
                // A comma, then the end of the object: the member that was expected is an empty primitive.
                return Err(primitive_error(""));
            }
            self.move_prev();
            let name = self.member_name()?;
            if !self.next_non_empty().is_some_and(|c| is(c, b':')) {
                return Err(self.debug(ERR_OBJECT));
            }
            let value = self.element(depth)?;
            match entries.iter_mut().find(|(key, _)| *key == name) {
                Some(slot) => slot.1 = value,
                None => entries.push((name, value)),
            }
            match self.next_non_empty() {
                Some(c) if is(c, b'}') => return Ok(Raw::Dict(entries)),
                Some(c) if is(c, b',') => first = false,
                _ => return Err(self.debug(ERR_OBJECT)),
            }
        }
    }

    fn member_name(&mut self) -> Result<String, String> {
        let Some(c) = self.next_non_empty() else { return Ok(String::new()) };
        self.move_prev();
        if is(c, b'"') || is(c, b'\'') {
            return self.string().map(|units| lossy(&units));
        }
        Ok(lossy(&self.token()))
    }

    /// The letters, digits and `. - _ +` from here on.
    fn token(&mut self) -> Vec<u16> {
        let mut token = Vec::new();
        while let Some(unit) = self.move_next() {
            let plain = [b'.', b'-', b'_', b'+'].iter().any(|c| is(unit, *c));
            if is_letter_or_digit(unit) || plain {
                token.push(unit);
            } else {
                self.move_prev();
                break;
            }
        }
        token
    }

    fn string(&mut self) -> Result<Vec<u16>, String> {
        let quote = self.move_next().unwrap_or(0);
        let mut out: Vec<u16> = Vec::new();
        let mut escaped = false;
        while let Some(c) = self.move_next() {
            if is(c, b'\\') {
                if escaped {
                    out.push(c);
                    escaped = false;
                } else {
                    escaped = true;
                }
                continue;
            }
            if escaped {
                self.escape(c, &mut out)?;
                escaped = false;
            } else {
                if c == quote {
                    return Ok(out);
                }
                out.push(c);
            }
        }
        Err(self.debug("Unterminated string passed in."))
    }

    fn escape(&mut self, c: u16, out: &mut Vec<u16>) -> Result<(), String> {
        if is(c, b'"') || is(c, b'\'') || is(c, b'/') {
            out.push(c);
        } else if is(c, b'b') {
            out.push(8);
        } else if is(c, b'f') {
            out.push(12);
        } else if is(c, b'n') {
            out.push(10);
        } else if is(c, b'r') {
            out.push(13);
        } else if is(c, b't') {
            out.push(9);
        } else if is(c, b'u') {
            // `(char)int.Parse(next four units, NumberStyles.HexNumber)`.
            if self.units.len().saturating_sub(self.index) < 4 {
                return Err("Value cannot be null.\r\nParameter name: String".to_string());
            }
            let digits = lossy(&self.units[self.index..self.index + 4]);
            self.index += 4;
            let trimmed = digits.trim_matches(|ch: char| matches!(ch, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r'));
            let unit = if trimmed.bytes().all(|b| b.is_ascii_hexdigit()) { u16::from_str_radix(trimmed, 16).ok() } else { None };
            out.push(unit.ok_or_else(|| "Input string was not in a correct format.".to_string())?);
        } else {
            return Err(self.debug("Unrecognized escape sequence."));
        }
        Ok(())
    }

    fn primitive(&mut self) -> Result<Value, String> {
        let token = lossy(&self.token());
        match token.as_str() {
            "null" => return Ok(Value::Null),
            "true" => return Ok(Value::Bool(true)),
            "false" => return Ok(Value::Bool(false)),
            _ => {}
        }
        if !token.contains('.') {
            if let Ok(number) = token.parse::<i32>() {
                return Ok(Value::Int(number));
            }
            if let Ok(number) = token.parse::<i64>() {
                return Ok(Value::Long(number));
            }
        }
        if let Some(decimal) = Decimal::parse(&token) {
            return Ok(Value::Decimal(decimal));
        }
        match parse_double(&token) {
            Some(number) => Ok(Value::Double(number)),
            None => Err(primitive_error(&token)),
        }
    }
}

/// `Double.TryParse(text, NumberStyles.Float, InvariantCulture)` of .NET Framework for a token without white space:
/// an optional sign, digits with an optional fraction, an optional exponent; `Infinity`, `-Infinity` and `NaN` by their
/// exact symbols. An overflow is no number; `-0` reads as `0`, as it does in .NET Framework.
fn parse_double(token: &str) -> Option<f64> {
    match token {
        "Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        "NaN" => return Some(f64::NAN),
        _ => {}
    }
    let bytes = token.as_bytes();
    let mut at = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let mut mantissa_digits = 0;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
        mantissa_digits += 1;
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return None;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let first = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == first {
            return None;
        }
    }
    if at != bytes.len() {
        return None;
    }
    let number = token.parse::<f64>().ok()?;
    if number.is_infinite() {
        return None;
    }
    Some(if number == 0.0 { 0.0 } else { number })
}

/// A string that began `"\/Date(`: `/Date(<ms>)/` with an optional zone letter or `+hhmm`/`-hhmm` (ignored) is a UTC
/// `DateTime` of that many milliseconds since 1970 (the arithmetic wraps as C# does); anything else stays text. A date
/// outside 0001 to 9999 is an error.
fn date_or_text(text: String) -> Result<Value, String> {
    let Some(inner) = text.strip_prefix("/Date(").and_then(|rest| rest.strip_suffix(")/")) else { return Ok(Value::String(text)) };
    let signed = inner.strip_prefix('-').unwrap_or(inner);
    let digits_end = (inner.len() - signed.len()) + signed.bytes().take_while(u8::is_ascii_digit).count();
    let (number, suffix) = inner.split_at(digits_end);
    let zone_ok = match suffix.as_bytes() {
        [] => true,
        [letter] => letter.is_ascii_alphabetic(),
        [sign, rest @ ..] => matches!(sign, b'+' | b'-') && rest.len() == 4 && rest.iter().all(u8::is_ascii_digit),
    };
    let Ok(millis) = number.parse::<i64>() else { return Ok(Value::String(text)) };
    if !zone_ok {
        return Ok(Value::String(text));
    }
    let ticks = millis.wrapping_mul(10_000).wrapping_add(EPOCH_TICKS);
    if !(0..=MAX_DATE_TICKS).contains(&ticks) {
        return Err("Ticks must be between DateTime.MinValue.Ticks and DateTime.MaxValue.Ticks.\r\nParameter name: ticks".to_string());
    }
    Ok(Value::DateTime(DateTimeValue { ticks, kind: DateKind::Utc }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_compare_without_case() {
        assert!(names_equal("Left", "lEFT"));
        assert!(names_equal("ключ", "Ключ"));
        assert!(!names_equal("ß", "SS"));
    }

    #[test]
    fn a_request_reads_as_powershell_reads_it() {
        let value = parse_payload(r#"{"Action":"open","n":5,"big":3000000000,"f":1.50,"e":1e3}"#).expect("payload");
        assert_eq!(property(&value, "action"), Value::string("open"));
        assert_eq!(property(&value, "N"), Value::Int(5));
        assert_eq!(property(&value, "big"), Value::Long(3_000_000_000));
        assert_eq!(property(&value, "f"), Value::Decimal(Decimal::parse("1.50").expect("decimal")));
        assert_eq!(property(&value, "e"), Value::Double(1000.0));
        assert_eq!(property(&value, "missing"), Value::Null);
    }

    #[test]
    fn keys_that_differ_by_case_are_refused() {
        let error = parse_payload(r#"{"a":1,"A":2}"#).expect_err("duplicate");
        assert!(error.contains("duplicated keys 'a' and 'A'"), "{error}");
    }

    #[test]
    fn a_trailing_comma_is_an_empty_primitive() {
        assert_eq!(parse_payload(r#"{"a":1,}"#), Err("Invalid JSON primitive: .".to_string()));
    }

    #[test]
    fn operation_property_prefers_the_direct_value() {
        let op = parse_payload(r#"{"left":72,"zero":null,"properties":{"left":10,"zero":4}}"#).expect("op");
        assert_eq!(operation_property(&op, "left", Value::Int(99)), Value::Int(72));
        assert_eq!(operation_property(&op, "zero", Value::Int(99)), Value::Int(4));
        assert_eq!(operation_property(&op, "absent", Value::Int(99)), Value::Int(99));
    }

    #[test]
    fn a_date_string_becomes_a_utc_date() {
        let value = parse_payload(r#"{"d":"\/Date(0)\/","s":"/Date(0)/"}"#).expect("payload");
        assert_eq!(property(&value, "d"), Value::DateTime(DateTimeValue { ticks: EPOCH_TICKS, kind: DateKind::Utc }));
        assert_eq!(property(&value, "s"), Value::string("/Date(0)/"));
    }
}
