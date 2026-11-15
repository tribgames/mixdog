//! Image codecs of the reader that pdf.js 6.4.299 runs as WebAssembly: JBIG2 (`jbig2`, with the MQ arithmetic coder of
//! `arith`) and CCITT G3/G4 (`ccitt`). Both are PDFium's decoders (`core/fxcodec/jbig2` and `fax`, the code of
//! pdfjs-dist's `wasm/jbig2.wasm`), ported with their error behaviour: a damaged stream decodes as far as PDFium
//! decodes it, and what the wasm wrapper reports as a failure is a [`CodecError`] here.

pub mod arith;
pub mod ccitt;
pub mod jbig2;
pub mod jpx;

use std::fmt;

/// A failure of one of the codecs, worded as the exception pdf.js's wrapper throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// `Jbig2Error("Unknown error")`: the decoder produced no image.
    Unknown,
    /// The wasm trap `RuntimeError: divide by zero` (a JBIG2 image of width 0).
    DivideByZero,
    /// Any other message of a JavaScript exception (`RangeError` of an impossible buffer length).
    Message(String),
}

impl CodecError {
    /// The `message` of the exception.
    pub fn message(&self) -> &str {
        match self {
            CodecError::Unknown => "Unknown error",
            CodecError::DivideByZero => "divide by zero",
            CodecError::Message(m) => m,
        }
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CodecError {}

/// JavaScript `ToInt32` of a number, the conversion a wasm `i32` parameter applies to the width, height and options
/// pdf.js passes (`NaN` and the infinities become 0, fractions are truncated, the value wraps modulo 2^32).
pub fn to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    let wrapped = value.trunc().rem_euclid(4_294_967_296.0);
    wrapped as u32 as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_int32_follows_javascript() {
        assert_eq!(to_int32(12.9), 12);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
        assert_eq!(to_int32(4_294_967_308.0), 12);
        assert_eq!(to_int32(2_147_483_648.0), i32::MIN);
        assert_eq!(to_int32(-2_147_483_649.0), i32::MAX);
    }

    #[test]
    fn error_messages_are_the_exception_texts() {
        assert_eq!(CodecError::Unknown.to_string(), "Unknown error");
        assert_eq!(CodecError::DivideByZero.message(), "divide by zero");
        assert_eq!(CodecError::Message("x".into()).message(), "x");
    }
}
