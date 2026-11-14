//! PDF stream filters and the standard security handler, ported from pdf.js 6.4.299 (see NOTICE).
//!
//! The filters are plain functions from the encoded bytes to the decoded bytes, each with an output limit the caller
//! sets: [`flate::inflate`], [`lzw::decode`], [`ascii85::decode`], [`asciihex::decode`], [`runlength::decode`] and
//! [`predictor::decode`]. They keep pdf.js's tolerance: damaged or cut data gives what was decoded before the damage.
//! [`decode_chain`] applies a stream's `Filter` array the way pdf.js's `makeFilter` does. [`security`] opens an
//! encrypted document with a password and decrypts its strings and streams.

pub mod ascii85;
pub mod asciihex;
pub mod flate;
pub mod lzw;
pub mod predictor;
pub mod rc4;
pub mod runlength;
pub mod security;

use std::fmt;

pub use predictor::PredictorParams;

/// pdf.js's `FormatError`: the data cannot be decoded at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    Format(String),
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodecError::Format(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CodecError {}

/// One entry of a stream's `Filter` array with its `DecodeParms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    Flate(Option<PredictorParams>),
    Lzw { early_change: i64, predictor: Option<PredictorParams> },
    Ascii85,
    AsciiHex,
    RunLength,
    /// A filter this crate does not decode (the image codecs, `Crypt`, an unknown name): the data passes through.
    PassThrough,
}

impl Filter {
    /// The filter `name` stands for (long and abbreviated names). `early_change` is `EarlyChange` when the
    /// parameters have it (1 otherwise).
    pub fn from_name(name: &str, predictor: Option<PredictorParams>, early_change: Option<i64>) -> Filter {
        match name {
            "Fl" | "FlateDecode" => Filter::Flate(predictor),
            "LZW" | "LZWDecode" => Filter::Lzw { early_change: early_change.unwrap_or(1), predictor },
            "A85" | "ASCII85Decode" => Filter::Ascii85,
            "AHx" | "ASCIIHexDecode" => Filter::AsciiHex,
            "RL" | "RunLengthDecode" => Filter::RunLength,
            _ => Filter::PassThrough,
        }
    }
}

/// Applies `filters` in order. Each stage's output stops at `limit` bytes. As in pdf.js's `makeFilter`, a stage that
/// cannot start (a bad flate header, a predictor number nobody defined) gives an empty stream; a predictor row
/// with an unknown filter byte is an error.
pub fn decode_chain(data: &[u8], filters: &[Filter], limit: usize) -> Result<Vec<u8>, CodecError> {
    let mut current = data.to_vec();
    for filter in filters {
        current = match filter {
            Filter::Flate(predictor) => match flate::inflate(&current, limit) {
                Ok(inflated) => unpredict(inflated, predictor.as_ref(), limit)?,
                Err(_) => Vec::new(),
            },
            Filter::Lzw { early_change, predictor } => {
                unpredict(lzw::decode(&current, *early_change, limit), predictor.as_ref(), limit)?
            }
            Filter::Ascii85 => ascii85::decode(&current, limit),
            Filter::AsciiHex => asciihex::decode(&current, limit),
            Filter::RunLength => runlength::decode(&current, limit),
            Filter::PassThrough => current,
        };
    }
    Ok(current)
}

fn unpredict(decoded: Vec<u8>, params: Option<&PredictorParams>, limit: usize) -> Result<Vec<u8>, CodecError> {
    let Some(params) = params else { return Ok(decoded) };
    if params.predictor <= 1 {
        return Ok(decoded);
    }
    if params.predictor != 2 && !(10..=15).contains(&params.predictor) {
        return Ok(Vec::new());
    }
    predictor::decode(&decoded, params, limit)
}
