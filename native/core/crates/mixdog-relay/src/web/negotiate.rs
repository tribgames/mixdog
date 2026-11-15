//! Content negotiation of static files (`lib/static-http.mjs`): the precompressed `.br` and `.gz` siblings `npm run
//! stage:web` writes beside each text asset, and the live gzip a raw build (a LAN or dev server) falls back to.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use mixdog_fsio::ReadProof;

use crate::js;

/// Text assets ship uncompressed otherwise: the renderer bundle alone is about 1.3 MB over a phone link. woff and woff2 and
/// raster images are already compressed, so they stay raw; TrueType is uncompressed tables.
fn compressible_type(content_type: &str) -> bool {
    ["text/", "image/svg", "font/ttf"].iter().any(|prefix| content_type.starts_with(prefix))
        || content_type.starts_with("application/json")
        || content_type.starts_with("application/wasm")
}

/// Smaller bodies are not worth compressing; the limit is exclusive (`size > COMPRESS_MIN_BYTES`).
pub const COMPRESS_MIN_BYTES: u64 = 1024;

/// `COMPRESSIBLE_TYPE.test(type) && size > COMPRESS_MIN_BYTES`.
pub fn is_compressible(content_type: &str, size: u64) -> bool {
    compressible_type(content_type) && size > COMPRESS_MIN_BYTES
}

/// An encoding a staged sibling carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Brotli,
    Gzip,
}

impl Encoding {
    /// The `Content-Encoding` and `Accept-Encoding` token; also what the ETag of that representation is salted with.
    pub fn name(self) -> &'static str {
        match self {
            Self::Brotli => "br",
            Self::Gzip => "gzip",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Brotli => ".br",
            Self::Gzip => ".gz",
        }
    }
}

/// The sibling file to answer with and its encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Precompressed {
    pub path: PathBuf,
    pub encoding: Encoding,
}

/// `parseAcceptEncoding`: Accept-Encoding as a name to quality table. q=0 is an explicit refusal, not a preference:
/// `gzip;q=0` or `*;q=0` means the client cannot decode that body, and answering it encoded anyway breaks the response.
pub fn parse_accept_encoding(header: Option<&str>) -> HashMap<String, f64> {
    let mut table = HashMap::new();
    for part in header.unwrap_or_default().split(',') {
        let mut pieces = part.split(';');
        let name = js::js_trim(pieces.next().unwrap_or_default()).to_lowercase();
        if name.is_empty() {
            continue;
        }
        let mut quality = 1.0;
        for parameter in pieces {
            if let Some(value) = quality_parameter(parameter) {
                quality = value;
            }
        }
        table.insert(name, quality);
    }
    table
}


/// `/^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i` and `Number(match[1])`: digits, an optional point and at least one digit after
/// it (`1.` does not match, so the quality stays 1).
fn quality_parameter(parameter: &str) -> Option<f64> {
    let rest = js::js_trim(parameter).strip_prefix(['q', 'Q'])?;
    let number = js::js_trim(js::js_trim(rest).strip_prefix('=')?);
    let (whole, fraction) = match number.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (number, None),
    };
    let digits = |text: &str| text.bytes().all(|b| b.is_ascii_digit());
    let valid = match fraction {
        Some(fraction) => digits(whole) && !fraction.is_empty() && digits(fraction),
        None => !whole.is_empty() && digits(whole),
    };
    if valid { number.parse().ok() } else { None }
}

/// `encodingAccepted`: true only when the client actually accepts `encoding`, by name or through `*`.
pub fn encoding_accepted(header: Option<&str>, encoding: &str) -> bool {
    let table = parse_accept_encoding(header);
    match table.get(encoding) {
        Some(quality) => *quality > 0.0,
        None => table.get("*").is_some_and(|quality| *quality > 0.0),
    }
}

/// `precompressedSibling`: a negotiated sibling never passes through the target resolution, so it repeats its escape check.
/// The sibling's real path must be exactly the asset's real path plus the suffix: a symlinked `.br` beside a public file
/// would otherwise answer with bytes from outside the renderer root.
fn precompressed_sibling<P: ReadProof>(proof: &P, target: &Path, encoding: Encoding) -> Option<PathBuf> {
    let mut sibling = OsString::from(target);
    sibling.push(encoding.suffix());
    let sibling = PathBuf::from(sibling);
    if !mixdog_fsio::exists(proof, &sibling).unwrap_or(false) {
        return None;
    }
    let mut expected = mixdog_fsio::canonicalize(proof, target).ok()?.into_os_string();
    expected.push(encoding.suffix());
    if mixdog_fsio::canonicalize(proof, &sibling).ok()? != PathBuf::from(expected) {
        return None;
    }
    mixdog_fsio::metadata(proof, &sibling).ok()?.is_file().then_some(sibling)
}

/// `selectPrecompressed`: the staged sibling the client accepts, brotli before gzip. `npm run stage:web` writes them beside
/// each text asset, so the relay ships brotli (well under on-the-fly gzip on a phone link) without spending CPU per request.
/// `None` when nothing suitable was staged, leaving the live gzip in charge.
pub fn select_precompressed<P: ReadProof>(proof: &P, target: &Path, accept_encoding: Option<&str>) -> Option<Precompressed> {
    [Encoding::Brotli, Encoding::Gzip].into_iter().find_map(|encoding| {
        if !encoding_accepted(accept_encoding, encoding.name()) {
            return None;
        }
        precompressed_sibling(proof, target, encoding).map(|path| Precompressed { path, encoding })
    })
}

/// `createGzip({ level: 6 })` fed chunk by chunk.
pub struct LiveGzip {
    encoder: GzEncoder<Vec<u8>>,
}

impl Default for LiveGzip {
    fn default() -> Self {
        Self { encoder: GzEncoder::new(Vec::new(), Compression::new(6)) }
    }
}

impl LiveGzip {
    /// Takes `chunk` in and returns the compressed bytes ready so far.
    pub fn push(&mut self, chunk: &[u8]) -> io::Result<Vec<u8>> {
        self.encoder.write_all(chunk)?;
        Ok(std::mem::take(self.encoder.get_mut()))
    }

    /// Ends the stream and returns the bytes still owed.
    pub fn finish(self) -> io::Result<Vec<u8>> {
        self.encoder.finish()
    }
}
