//! The parts of Windows PowerShell 5.1 whose behaviour shows in the Office COM hosts' requests and results.
//!
//! The hosts (`assets/*.ps1`) read each request with `ConvertFrom-Json`, cast with `[int]`, `[double]`, `[string]` and
//! friends, sort and group with `Sort-Object` and `Group-Object`, write each answer with `ConvertTo-Json -Compress` and
//! fingerprint a snapshot by the hash of that text. A host written in Rust has to produce the same answers byte for byte
//! (a journal written by the PowerShell host must still verify), so these modules reproduce the PowerShell rules over one
//! value model, [`Value`]. `tests/pswire.rs` checks every function against `tests/fixtures/pswire/corpus.json`, the text
//! Windows PowerShell 5.1 produced for the same inputs (`recorder/pswire-corpus.ps1`).
//!
//! * [`payload`] reads a request line as `ConvertFrom-Json` does and looks properties up as `$payload.name` does.
//! * [`convert`] holds the casts, number text, `[Math]` overloads, `-f '{0:X2}'` and the arithmetic of the colour code.
//! * [`collate`] is `Sort-Object` and `Group-Object` (culture-aware, case-insensitive, stable).
//! * [`text`] is `-match`, `-replace`, `-split`, `-like`, `[regex]::Escape`, `TrimEnd` and `-join`.
//! * [`datetime`] turns a `VT_DATE` into the text `ToUniversalTime().ToString('o')` gives.
//! * [`json`] is the `ConvertTo-Json -Compress` writer and the host's `Emit-Json` line.
//! * [`fingerprint`] is `Text-Sha256` and `Snapshot-Fingerprint`.

pub mod collate;
pub mod convert;
pub mod datetime;
pub mod fingerprint;
pub mod json;
pub mod payload;
pub mod text;

use std::fmt::Write as _;

/// A PowerShell value as the hosts see and write it.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// `$null`.
    Null,
    /// `[System.DBNull]::Value` (a COM VT_NULL).
    DbNull,
    Bool(bool),
    /// `[int]`; also what a .NET enum is written as.
    Int(i32),
    /// `[int64]`.
    Long(i64),
    /// `[double]`.
    Double(f64),
    /// `[single]`.
    Single(f32),
    Decimal(Decimal),
    String(String),
    /// A `[DateTime]` as ticks of 100 ns since 0001-01-01 and its `Kind`.
    DateTime(DateTimeValue),
    /// `object[]`.
    Array(Vec<Value>),
    /// An `[ordered]` dictionary or a `PSCustomObject`.
    Object(Object),
}

/// What kind of object a [`Value::Object`] is: it decides how the object is written past the depth limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectKind {
    /// `[ordered]@{}` (a `System.Collections.Specialized.OrderedDictionary`).
    Ordered,
    /// `[pscustomobject]` (what `ConvertFrom-Json` returns for an object).
    Custom,
}

/// The kind of a `[DateTime]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateKind {
    Unspecified,
    Utc,
    Local,
}

/// A `[DateTime]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateTimeValue {
    pub ticks: i64,
    pub kind: DateKind,
}

/// A dictionary with the key order it was built in. Keys are unique under the case-insensitive comparison PowerShell uses
/// for property names; the first spelling of a key is kept.
#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    pub kind: ObjectKind,
    pub entries: Vec<(String, Value)>,
}

impl Object {
    pub fn new(kind: ObjectKind) -> Self {
        Object { kind, entries: Vec::new() }
    }

    /// `$obj[key] = value`: replaces the value of an existing key (any case), otherwise appends.
    pub fn set(&mut self, key: &str, value: Value) {
        match self.position(key) {
            Some(at) => self.entries[at].1 = value,
            None => self.entries.push((key.to_string(), value)),
        }
    }

    /// `$obj.PSObject.Properties[key]`: the value of the property of that name in any case, `None` if there is none.
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.position(key).map(|at| &self.entries[at].1)
    }

    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|(name, _)| payload::names_equal(name, key))
    }
}

impl Value {
    /// A `[pscustomobject]` or `[ordered]` dictionary of the pairs in this order.
    pub fn object(kind: ObjectKind, pairs: Vec<(&str, Value)>) -> Value {
        let mut object = Object::new(kind);
        for (key, value) in pairs {
            object.set(key, value);
        }
        Value::Object(object)
    }

    pub fn string(text: &str) -> Value {
        Value::String(text.to_string())
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

/// A .NET `System.Decimal`: a 96-bit integer, a sign and a scale of 0 to 28 digits. The scale is kept (`1.50` writes as
/// `1.50`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decimal {
    pub negative: bool,
    pub mantissa: u128,
    pub scale: u8,
}

/// The largest mantissa a Decimal holds (2^96 - 1).
const DECIMAL_MAX: u128 = (1u128 << 96) - 1;

impl Decimal {
    /// `Decimal.TryParse(text, NumberStyles.Number, InvariantCulture)` of .NET Framework, which is what JavaScriptSerializer
    /// calls for a number with a fraction: an optional sign (leading or trailing, not both), digits with an optional
    /// fraction, no exponent. The scale is that of the text (`1.50` keeps two digits), digits past 28 places are rounded
    /// half to even and a value too large for 96 bits is `None` (the caller then reads a double). Zero has no sign.
    pub fn parse(text: &str) -> Option<Decimal> {
        // `Number.ParseNumber` keeps at most this many digits of the text.
        const MAX_DIGITS: usize = 50;
        let bytes = text.as_bytes();
        let mut at = 0;
        let mut negative = false;
        let mut signed = false;
        match bytes.first() {
            Some(b'-') => {
                negative = true;
                signed = true;
                at = 1;
            }
            Some(b'+') => {
                signed = true;
                at = 1;
            }
            _ => {}
        }
        let mut digits: Vec<u8> = Vec::new();
        let mut scale: i32 = 0;
        let mut seen_digit = false;
        let mut non_zero = false;
        let mut after_point = false;
        while let Some(&byte) = bytes.get(at) {
            match byte {
                b'0'..=b'9' => {
                    seen_digit = true;
                    if byte != b'0' || non_zero {
                        if digits.len() < MAX_DIGITS {
                            digits.push(byte);
                        }
                        if !after_point {
                            scale += 1;
                        }
                        non_zero = true;
                    } else if after_point {
                        scale -= 1;
                    }
                }
                b'.' if !after_point => after_point = true,
                _ => break,
            }
            at += 1;
        }
        if !seen_digit {
            return None;
        }
        if !signed {
            if let Some(&sign @ (b'-' | b'+')) = bytes.get(at) {
                negative = sign == b'-';
                at += 1;
            }
        }
        if at != bytes.len() {
            return None;
        }
        // `Number.NumberToDecimal`.
        let digit = |index: usize| digits.get(index).copied().unwrap_or(0);
        let mut position = 0;
        let mut exponent = scale;
        let mut value: u128 = 0;
        if digit(0) == 0 {
            exponent = exponent.min(0);
        } else {
            if exponent > 29 {
                return None;
            }
            while exponent > 0 || (digit(position) != 0 && exponent > -28) {
                let next = if digit(position) == 0 { 0 } else { u128::from(digit(position) - b'0') };
                match value.checked_mul(10).map(|shifted| shifted + next) {
                    Some(grown) if grown <= DECIMAL_MAX => value = grown,
                    _ => break,
                }
                if digit(position) != 0 {
                    position += 1;
                }
                exponent -= 1;
            }
            let rounding_digit = digit(position);
            position += 1;
            if rounding_digit >= b'5' {
                let mut round = true;
                let previous_even = position < 2 || (digit(position - 2) - b'0') % 2 == 0;
                if rounding_digit == b'5' && previous_even {
                    // Half way unless something but zeros follows within the next 20 digits.
                    let mut count = 20;
                    while digit(position) == b'0' && count != 0 {
                        position += 1;
                        count -= 1;
                    }
                    if digit(position) == 0 || count == 0 {
                        round = false;
                    }
                }
                if round {
                    if value == DECIMAL_MAX {
                        value = DECIMAL_MAX / 10 + 1;
                        exponent += 1;
                    } else {
                        value += 1;
                    }
                }
            }
        }
        if exponent > 0 {
            return None;
        }
        if exponent <= -29 {
            return Some(Decimal { negative: false, mantissa: 0, scale: 28 });
        }
        Some(Decimal { negative: negative && value != 0, mantissa: value, scale: (-exponent) as u8 })
    }

    /// `Decimal.ToString(InvariantCulture)`.
    pub fn to_text(&self) -> String {
        let digits = self.mantissa.to_string();
        let scale = self.scale as usize;
        let mut out = String::new();
        if self.negative && self.mantissa != 0 {
            out.push('-');
        }
        if scale == 0 {
            out.push_str(&digits);
        } else if digits.len() > scale {
            out.push_str(&digits[..digits.len() - scale]);
            out.push('.');
            out.push_str(&digits[digits.len() - scale..]);
        } else {
            out.push_str("0.");
            for _ in digits.len()..scale {
                out.push('0');
            }
            out.push_str(&digits);
        }
        out
    }

    /// `[double]$decimal`.
    pub fn to_f64(&self) -> f64 {
        let value = self.mantissa as f64 / 10f64.powi(self.scale as i32);
        if self.negative { -value } else { value }
    }

    /// The decimal as a whole number rounded to even (`Decimal.Round`), `None` if it does not fit an i128.
    pub fn round_to_i128(&self) -> Option<i128> {
        let power = 10u128.checked_pow(self.scale as u32)?;
        let whole = self.mantissa / power;
        let rest = self.mantissa % power;
        let twice = rest * 2;
        let up = twice > power || (twice == power && whole % 2 == 1);
        let magnitude = i128::try_from(whole + u128::from(up)).ok()?;
        Some(if self.negative { -magnitude } else { magnitude })
    }

    pub fn is_zero(&self) -> bool {
        self.mantissa == 0
    }
}

/// `$value | ...` over a function result or a pipeline: one element arrives as that element, no element as `$null`, more
/// than one as an array. A string, a dictionary and a scalar are not enumerated; an array is.
pub fn unroll(items: Vec<Value>) -> Value {
    let mut items = items;
    match items.len() {
        0 => Value::Null,
        1 => items.remove(0),
        _ => Value::Array(items),
    }
}

/// What a pipeline sees of `value`: an array is enumerated, anything else is one item.
pub fn pipeline_items(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

/// `"{0:X}"` of the bytes, used by the fingerprint: lower-case hex.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}
