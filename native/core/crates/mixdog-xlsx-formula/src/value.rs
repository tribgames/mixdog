//! The values a formula works with: the shapes `@formulajs/formulajs` receives and returns (a number, text, a
//! boolean, an empty cell, an error object, a `Date`, a nested array of these), and the error values of its
//! `utils.errors` set.

use std::fmt;

/// The error values of formulajs `utils.errors`. The engine reads and writes the first eight (`ERROR_VALUE` of the
/// Node engine) as cell errors; `#ERROR!` and `#CALC!` exist only inside a library function and leave the engine as
/// `#VALUE!`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorValue {
    /// `#NULL!`
    Nil,
    /// `#DIV/0!`
    Div0,
    /// `#VALUE!`
    Value,
    /// `#REF!`
    Ref,
    /// `#NAME?`
    Name,
    /// `#NUM!`
    Num,
    /// `#N/A`
    Na,
    /// `#ERROR!`
    Error,
    /// `#GETTING_DATA`
    Data,
    /// `#CALC!`
    Calc,
}

impl ErrorValue {
    /// The text of the error, as the formulajs `Error` carries it in `message`.
    pub const fn message(self) -> &'static str {
        match self {
            Self::Nil => "#NULL!",
            Self::Div0 => "#DIV/0!",
            Self::Value => "#VALUE!",
            Self::Ref => "#REF!",
            Self::Name => "#NAME?",
            Self::Num => "#NUM!",
            Self::Na => "#N/A",
            Self::Error => "#ERROR!",
            Self::Data => "#GETTING_DATA",
            Self::Calc => "#CALC!",
        }
    }

    /// The error whose text is `text`, among all ten.
    pub fn from_message(text: &str) -> Option<Self> {
        const ALL: [ErrorValue; 10] = [
            ErrorValue::Nil,
            ErrorValue::Div0,
            ErrorValue::Value,
            ErrorValue::Ref,
            ErrorValue::Name,
            ErrorValue::Num,
            ErrorValue::Na,
            ErrorValue::Error,
            ErrorValue::Data,
            ErrorValue::Calc,
        ];
        ALL.into_iter().find(|error| error.message() == text)
    }

    /// Whether the engine reads the text of this error as a cell error: `isFormulaError` of the Node engine, whose
    /// `ERROR_VALUE` leaves out `#ERROR!` and `#CALC!`.
    pub const fn is_cell_error(self) -> bool {
        !matches!(self, Self::Error | Self::Calc)
    }
}

impl fmt::Display for ErrorValue {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.message())
    }
}

/// A JavaScript value as a formula function sees it. Arrays nest the way a range does: a range is an array of row
/// arrays.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// `undefined`: an omitted argument, a missing element.
    Undefined,
    /// `null`.
    Null,
    Number(f64),
    Text(String),
    /// A JavaScript string containing isolated UTF-16 surrogates. Construct via
    /// from_utf16: well-formed strings retain the ordinary Text representation.
    Utf16(Vec<u16>),
    Bool(bool),
    /// An `Error` object of the formulajs set.
    Error(ErrorValue),
    /// A `Date`: its time value in milliseconds since the epoch (`NaN` for an invalid date), read in the local zone.
    Date(f64),
    Array(Vec<Value>),
}

impl Value {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(text.into())
    }

    pub fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => Self::Text(text),
            Err(_) => Self::Utf16(units),
        }
    }

    pub fn is_text(&self) -> bool {
        matches!(self, Self::Text(_) | Self::Utf16(_))
    }

    pub fn text_units(&self) -> Option<Vec<u16>> {
        match self {
            Self::Text(text) => Some(text.encode_utf16().collect()),
            Self::Utf16(units) => Some(units.clone()),
            _ => None,
        }
    }

    /// Explicit UTF-8 output boundary, equivalent to Buffer.from(str, "utf8").
    /// Never use this for intermediate formula string operations.
    pub fn text_to_utf8_lossy(&self) -> Option<String> {
        self.text_units().map(|units| String::from_utf16_lossy(&units))
    }

    /// An empty cell or empty text: what Excel reads as blank (`isBlank` of the Node engine).
    pub fn is_blank(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => true,
            Self::Text(text) => text.is_empty(),
            Self::Utf16(units) => units.is_empty(),
            _ => false,
        }
    }

    /// Whether the value is one of the cell errors the engine propagates (`isFormulaError` of the Node engine): an
    /// error object of the set, or text that reads as one.
    pub fn is_formula_error(&self) -> bool {
        match self {
            Self::Error(error) => error.is_cell_error(),
            Self::Text(text) => cell_error_of(text).is_some(),
            _ => false,
        }
    }

    /// Text that reads as a cell error becomes that error; every other value is unchanged. The engine keeps its
    /// values in this form, so `isFormulaError` is a match on the variant.
    pub fn canonical(self) -> Self {
        match self {
            Self::Text(text) => match cell_error_of(&text) {
                Some(error) => Self::Error(error),
                None => Self::Text(text),
            },
            Self::Utf16(units) => match Self::from_utf16(units) {
                Self::Text(text) => Self::Text(text).canonical(),
                other => other,
            },
            Self::Array(items) => Self::Array(items.into_iter().map(Self::canonical).collect()),
            other => other,
        }
    }
}

/// `ERROR_VALUE` of the Node engine: `/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|GETTING_DATA)$/`.
pub fn cell_error_of(text: &str) -> Option<ErrorValue> {
    ErrorValue::from_message(text).filter(|error| error.is_cell_error())
}

/// `isFormulaError(value)`.
pub fn is_formula_error(value: &Value) -> bool {
    value.is_formula_error()
}

/// `isBlank(value)`.
pub fn is_blank(value: &Value) -> bool {
    value.is_blank()
}

/// A formula the engine refuses to evaluate, with the reason the caller reports (`UnsupportedFormula` of the Node
/// engine).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedFormula {
    pub reason: String,
}

impl fmt::Display for UnsupportedFormula {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.reason)
    }
}

/// Why an evaluation did not produce a value: a refusal, or an exception the Node engine would let escape (a
/// function that throws, `parseCellRef` on `A0`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Unsupported(UnsupportedFormula),
    /// The message of the exception.
    Thrown(String),
}

impl Failure {
    /// `UnsupportedFormula` with `reason`.
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self::Unsupported(UnsupportedFormula { reason: reason.into() })
    }

    pub fn thrown(message: impl Into<String>) -> Self {
        Self::Thrown(message.into())
    }
}

impl From<UnsupportedFormula> for Failure {
    fn from(refusal: UnsupportedFormula) -> Self {
        Self::Unsupported(refusal)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(refusal) => refusal.fmt(out),
            Self::Thrown(message) => out.write_str(message),
        }
    }
}

impl std::error::Error for UnsupportedFormula {}
impl std::error::Error for Failure {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_errors_are_the_eight_the_engine_reads() {
        for text in ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#GETTING_DATA"] {
            assert!(cell_error_of(text).is_some(), "{text}");
            assert!(Value::text(text).is_formula_error(), "{text}");
        }
        for text in ["#ERROR!", "#CALC!", "#div/0!", "#N/A ", "N/A", ""] {
            assert!(cell_error_of(text).is_none(), "{text}");
            assert!(!Value::text(text).is_formula_error(), "{text}");
        }
        assert_eq!(ErrorValue::from_message("#CALC!"), Some(ErrorValue::Calc));
    }

    #[test]
    fn canonical_turns_error_text_into_the_error_inside_arrays_too() {
        let value = Value::Array(vec![Value::text("#N/A"), Value::Array(vec![Value::text("#DIV/0!"), Value::text("x")])]);
        let Value::Array(items) = value.canonical() else { panic!("array") };
        assert!(matches!(items[0], Value::Error(ErrorValue::Na)));
        let Value::Array(inner) = &items[1] else { panic!("inner") };
        assert!(matches!(inner[0], Value::Error(ErrorValue::Div0)));
        assert!(matches!(&inner[1], Value::Text(text) if text == "x"));
    }

    #[test]
    fn blank_is_null_undefined_or_empty_text() {
        assert!(Value::Null.is_blank() && Value::Undefined.is_blank() && Value::text("").is_blank());
        assert!(!Value::text(" ").is_blank() && !Value::Number(0.0).is_blank() && !Value::Bool(false).is_blank());
    }
}
