//! The value a COM call takes and answers: a VARIANT at its exact type.
//!
//! PowerShell passes `$true` as `VT_BOOL` (-1/0), an Int32 as `VT_I4`, a Single as `VT_R4`, a .NET Decimal (what
//! `ConvertFrom-Json` makes of a large number) as `VT_DECIMAL`, and `[Type]::Missing` as a `VT_ERROR` carrying
//! `DISP_E_PARAMNOTFOUND`. The variants here keep each of those apart, so a call goes out with the type the recording
//! shows.

use std::fmt;

use super::Obj;
use super::SafeArray;

/// A .NET `Decimal` as the `DECIMAL` structure holds it: a 96-bit magnitude, a sign and a power-of-ten scale (0..=28).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decimal {
    /// The sign.
    pub negative: bool,
    /// The number of digits after the decimal point.
    pub scale: u8,
    /// The high 32 bits of the magnitude.
    pub hi32: u32,
    /// The low 64 bits of the magnitude.
    pub lo64: u64,
}

impl Decimal {
    /// The largest scale a `DECIMAL` has.
    pub const MAX_SCALE: u8 = 28;

    /// An integer.
    pub fn from_i64(value: i64) -> Decimal {
        Decimal { negative: value < 0, scale: 0, hi32: 0, lo64: value.unsigned_abs() }
    }

    fn magnitude(&self) -> u128 {
        (u128::from(self.hi32) << 64) | u128::from(self.lo64)
    }

    /// Parses `[-+]digits[.digits]` (no exponent). `None` when it is not that, or the magnitude does not fit 96 bits,
    /// or it has more than 28 fractional digits.
    pub fn parse(text: &str) -> Option<Decimal> {
        let (negative, body) = match text.as_bytes().first()? {
            b'-' => (true, &text[1..]),
            b'+' => (false, &text[1..]),
            _ => (false, text),
        };
        let (whole, fraction) = match body.split_once('.') {
            Some((whole, fraction)) => (whole, fraction),
            None => (body, ""),
        };
        if whole.is_empty() && fraction.is_empty() {
            return None;
        }
        if !whole.bytes().chain(fraction.bytes()).all(|b| b.is_ascii_digit()) {
            return None;
        }
        if fraction.len() > usize::from(Self::MAX_SCALE) {
            return None;
        }
        let mut magnitude: u128 = 0;
        for digit in whole.bytes().chain(fraction.bytes()) {
            magnitude = magnitude.checked_mul(10)?.checked_add(u128::from(digit - b'0'))?;
        }
        if magnitude >> 96 != 0 {
            return None;
        }
        Some(Decimal {
            negative,
            scale: fraction.len() as u8,
            hi32: (magnitude >> 64) as u32,
            lo64: magnitude as u64,
        })
    }

    /// The nearest `f64`.
    pub fn to_f64(&self) -> f64 {
        let magnitude = self.magnitude() as f64 / 10f64.powi(i32::from(self.scale));
        if self.negative { -magnitude } else { magnitude }
    }
}

impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let digits = self.magnitude().to_string();
        let scale = usize::from(self.scale);
        let padded = if digits.len() <= scale { format!("{}{digits}", "0".repeat(scale + 1 - digits.len())) } else { digits };
        let split = padded.len() - scale;
        let sign = if self.negative { "-" } else { "" };
        if scale == 0 {
            write!(f, "{sign}{padded}")
        } else {
            write!(f, "{sign}{}.{}", &padded[..split], &padded[split..])
        }
    }
}

/// One VARIANT.
#[derive(Clone, Debug)]
pub enum Value {
    /// `VT_EMPTY`.
    Empty,
    /// `VT_NULL`, and PowerShell's `$null` on the way in.
    Null,
    /// `VT_BOOL`.
    Bool(bool),
    /// `VT_I1`.
    I1(i8),
    /// `VT_I2`.
    I2(i16),
    /// `VT_I4` (and `VT_INT`).
    I4(i32),
    /// `VT_I8`.
    I8(i64),
    /// `VT_UI1`.
    UI1(u8),
    /// `VT_UI2`.
    UI2(u16),
    /// `VT_UI4` (and `VT_UINT`).
    UI4(u32),
    /// `VT_UI8`.
    UI8(u64),
    /// `VT_R4`.
    R4(f32),
    /// `VT_R8`.
    R8(f64),
    /// `VT_CY`: ten-thousandths of a unit.
    Currency(i64),
    /// `VT_DATE`: days since 1899-12-30.
    Date(f64),
    /// `VT_BSTR`.
    Str(String),
    /// `VT_ERROR` with an scode (a cell error such as `#N/A` is 0x800A07FA).
    Error(i32),
    /// `VT_DECIMAL`.
    Decimal(Decimal),
    /// `VT_DISPATCH`.
    Dispatch(Obj),
    /// `VT_UNKNOWN`.
    Unknown(Obj),
    /// `VT_ARRAY | VT_VARIANT`.
    Array(SafeArray),
    /// `[Type]::Missing`: `VT_ERROR` with `DISP_E_PARAMNOTFOUND`.
    Missing,
}

impl PartialEq for Value {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Empty, Value::Empty) | (Value::Null, Value::Null) | (Value::Missing, Value::Missing) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::I1(a), Value::I1(b)) => a == b,
            (Value::I2(a), Value::I2(b)) => a == b,
            (Value::I4(a), Value::I4(b)) => a == b,
            (Value::I8(a), Value::I8(b)) => a == b,
            (Value::UI1(a), Value::UI1(b)) => a == b,
            (Value::UI2(a), Value::UI2(b)) => a == b,
            (Value::UI4(a), Value::UI4(b)) => a == b,
            (Value::UI8(a), Value::UI8(b)) => a == b,
            (Value::R4(a), Value::R4(b)) => a == b,
            (Value::R8(a), Value::R8(b)) => a == b,
            (Value::Currency(a), Value::Currency(b)) => a == b,
            (Value::Date(a), Value::Date(b)) => a == b,
            (Value::Str(a), Value::Str(b)) => a == b,
            (Value::Error(a), Value::Error(b)) => a == b,
            (Value::Decimal(a), Value::Decimal(b)) => a == b,
            (Value::Dispatch(a), Value::Dispatch(b)) | (Value::Unknown(a), Value::Unknown(b)) => a.same_object(b),
            (Value::Array(a), Value::Array(b)) => a == b,
            _ => false,
        }
    }
}

impl Value {
    /// The VARIANT type name the call log uses.
    pub fn type_tag(&self) -> &'static str {
        match self {
            Value::Empty => "empty",
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::I1(_) => "i1",
            Value::I2(_) => "i2",
            Value::I4(_) => "i4",
            Value::I8(_) => "i8",
            Value::UI1(_) => "ui1",
            Value::UI2(_) => "ui2",
            Value::UI4(_) => "ui4",
            Value::UI8(_) => "ui8",
            Value::R4(_) => "r4",
            Value::R8(_) => "r8",
            Value::Currency(_) => "cy",
            Value::Date(_) => "date",
            Value::Str(_) => "str",
            Value::Error(_) => "error",
            Value::Decimal(_) => "decimal",
            Value::Dispatch(_) => "obj",
            Value::Unknown(_) => "unknown",
            Value::Array(_) => "array",
            Value::Missing => "missing",
        }
    }

    /// The .NET type name PowerShell prints for the value in an error text.
    pub fn dotnet_type_name(&self) -> &'static str {
        match self {
            Value::Empty | Value::Null | Value::Missing => "System.Reflection.Missing",
            Value::Bool(_) => "System.Boolean",
            Value::I1(_) => "System.SByte",
            Value::I2(_) => "System.Int16",
            Value::I4(_) => "System.Int32",
            Value::I8(_) => "System.Int64",
            Value::UI1(_) => "System.Byte",
            Value::UI2(_) => "System.UInt16",
            Value::UI4(_) => "System.UInt32",
            Value::UI8(_) => "System.UInt64",
            Value::R4(_) => "System.Single",
            Value::R8(_) => "System.Double",
            Value::Currency(_) | Value::Decimal(_) => "System.Decimal",
            Value::Date(_) => "System.DateTime",
            Value::Str(_) => "System.String",
            Value::Error(_) => "System.Int32",
            Value::Dispatch(_) | Value::Unknown(_) => "System.__ComObject",
            Value::Array(_) => "System.Object[]",
        }
    }

    /// `$null`, an empty VARIANT, or `[Type]::Missing`'s absent answer: what a non-strict property read treats as null.
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null | Value::Empty)
    }

    /// The object, when the value is one.
    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            Value::Dispatch(obj) | Value::Unknown(obj) => Some(obj),
            _ => None,
        }
    }

    /// The object, when the value is one.
    pub fn into_obj(self) -> Option<Obj> {
        match self {
            Value::Dispatch(obj) | Value::Unknown(obj) => Some(obj),
            _ => None,
        }
    }

    /// The text, when the value is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(text) => Some(text),
            _ => None,
        }
    }

    /// The truth value, when the value is a boolean.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            _ => None,
        }
    }

    /// An integer-typed value as `i64` (a `u64` above `i64::MAX` is `None`).
    pub fn as_i64(&self) -> Option<i64> {
        match *self {
            Value::I1(v) => Some(i64::from(v)),
            Value::I2(v) => Some(i64::from(v)),
            Value::I4(v) => Some(i64::from(v)),
            Value::I8(v) => Some(v),
            Value::UI1(v) => Some(i64::from(v)),
            Value::UI2(v) => Some(i64::from(v)),
            Value::UI4(v) => Some(i64::from(v)),
            Value::UI8(v) => i64::try_from(v).ok(),
            _ => None,
        }
    }

    /// Any numeric value as `f64`.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::R4(v) => Some(f64::from(*v)),
            Value::R8(v) | Value::Date(v) => Some(*v),
            Value::Currency(v) => Some(*v as f64 / 10_000.0),
            Value::Decimal(v) => Some(v.to_f64()),
            other => other.as_i64().map(|v| v as f64),
        }
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Value {
        Value::Bool(value)
    }
}

impl From<i32> for Value {
    fn from(value: i32) -> Value {
        Value::I4(value)
    }
}

impl From<i64> for Value {
    fn from(value: i64) -> Value {
        Value::I8(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Value {
        Value::R8(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Value {
        Value::Str(value.to_owned())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Value {
        Value::Str(value)
    }
}

impl From<Obj> for Value {
    fn from(value: Obj) -> Value {
        Value::Dispatch(value)
    }
}

impl From<SafeArray> for Value {
    fn from(value: SafeArray) -> Value {
        Value::Array(value)
    }
}
