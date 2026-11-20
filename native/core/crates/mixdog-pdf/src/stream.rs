//! Byte streams over file data and the stream objects the parser builds.
//!
//! [`ByteStream`] is pdf.js's `Stream`: a window `[start, end)` over shared bytes with a read position. A
//! [`PdfStream`] is a parsed `stream ... endstream` object: its raw bytes, its (resolved) filter chain and, when the
//! file is encrypted, the cipher of its object. Decoding goes through the [`StreamFilters`] and [`Decryptor`]
//! traits, so this crate does not depend on the codec crate.

use std::fmt;
use std::sync::Arc;

use crate::error::{Guard, PdfError, Result};
use crate::object::{Dict, Obj};

/// pdf.js's `Stream`: bytes with a window and a position. `pos` is public because pdf.js moves it freely.
#[derive(Clone)]
pub struct ByteStream {
    data: Arc<[u8]>,
    pub start: usize,
    pub end: usize,
    pub pos: usize,
}

impl fmt::Debug for ByteStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ByteStream").field("start", &self.start).field("end", &self.end).field("pos", &self.pos).finish()
    }
}

impl ByteStream {
    pub fn new(data: Arc<[u8]>) -> Self {
        let end = data.len();
        ByteStream { data, start: 0, end, pos: 0 }
    }

    pub fn from_vec(bytes: Vec<u8>) -> Self {
        ByteStream::new(Arc::from(bytes))
    }

    /// The whole underlying data, whatever the window.
    pub fn data(&self) -> &Arc<[u8]> {
        &self.data
    }

    /// `Stream.length`.
    pub fn length(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    /// `getByte`: the next byte, or -1 at the end.
    pub fn get_byte(&mut self) -> i32 {
        if self.pos >= self.end {
            return -1;
        }
        let byte = self.data[self.pos];
        self.pos += 1;
        i32::from(byte)
    }

    /// `peekByte`.
    pub fn peek_byte(&self) -> i32 {
        if self.pos >= self.end { -1 } else { i32::from(self.data[self.pos]) }
    }

    /// `peekBytes(length)`: up to `length` bytes from the position, without moving it.
    pub fn peek_bytes(&self, length: usize) -> &[u8] {
        if self.pos >= self.end {
            return &[];
        }
        &self.data[self.pos..self.end.min(self.pos.saturating_add(length))]
    }

    /// `getUint16`: -1 when fewer than two bytes remain.
    pub fn get_uint16(&mut self) -> i32 {
        let b0 = self.get_byte();
        let b1 = self.get_byte();
        if b0 == -1 || b1 == -1 { -1 } else { (b0 << 8) + b1 }
    }

    /// `skip(n)`: moves by `n`, and by one when `n` is 0 (`this.pos += n || 1`).
    pub fn skip(&mut self, n: isize) {
        let n = if n == 0 { 1 } else { n };
        self.pos = if n < 0 { self.pos.saturating_sub(n.unsigned_abs()) } else { self.pos.saturating_add(n.unsigned_abs()) };
    }

    /// `reset`.
    pub fn reset(&mut self) {
        self.pos = self.start;
    }

    /// `moveStart`: the window starts at the position.
    pub fn move_start(&mut self) {
        self.start = self.pos;
    }

    /// `makeSubStream(start, length)`: a window over the same data. `start` is absolute. Without a length (or when
    /// `start + length` is 0) the window runs to the end of the data, as `new Stream(buffer, start, length)` does.
    pub fn make_sub_stream(&self, start: usize, length: Option<usize>) -> ByteStream {
        let end = match length {
            Some(length) if start.saturating_add(length) != 0 => start.saturating_add(length),
            _ => self.data.len(),
        };
        ByteStream { data: self.data.clone(), start, end: end.min(self.data.len()), pos: start }
    }
}

/// What a stream filter reports for names it does not decode itself.
pub type FilterResult = Result<Option<Vec<u8>>>;

/// The decoders of the stream filters (`FlateDecode`, `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`,
/// `RunLengthDecode`, `DCTDecode`, ... with `DecodeParms` predictors). Implemented by the codec crate.
pub trait StreamFilters: Send + Sync {
    /// Decodes `data` with the filter `name` (the name as written in the file, abbreviations included). `params`
    /// is the filter's parameter dictionary with its indirect values resolved. `length` is the raw length of the
    /// stream for the first filter of a chain. The output must not pass `max_output` bytes.
    ///
    /// `Ok(None)` says the filter is not known (pdf.js: `Filter "x" is not supported.`: the data goes on
    /// undecoded). An `Err` other than a fatal one makes the stream empty (pdf.js: `Invalid stream`).
    fn decode(&self, name: &str, data: &[u8], params: Option<&Dict>, length: Option<usize>, max_output: usize) -> FilterResult;
}

/// The decryption of one document (strings and streams per object number and generation).
pub trait Decryptor: Send + Sync {
    /// A fresh constructor cache belongs to one createCipherTransform call.
    fn for_object(&self, _num: i64, _generation: i64) -> Option<Arc<dyn Decryptor>> {
        None
    }
    /// Only version 4/5 transforms inspect the stream Type for EFF selection.
    fn uses_embedded_filter(&self) -> bool {
        false
    }
    /// `cipherTransform.decryptString`.
    fn decrypt_string(&self, num: i64, generation: i64, data: &[u8], xref: Option<&crate::xref::Xref>) -> Result<Vec<u8>>;

    /// Select the cipher when the parser creates the stream, without decoding bytes.
    fn validate_stream(&self, _num: i64, _generation: i64, _crypt_name: Option<&str>, _embedded_file: bool, _xref: Option<&crate::xref::Xref>) -> Result<()> {
        Ok(())
    }

    /// `cipherTransform.createStream(...)` over the whole stream: `crypt_name` is the `/Name` of a `Crypt`
    /// filter, `None` for the document's default stream filter.
    fn decrypt_stream(&self, num: i64, generation: i64, data: &[u8], crypt_name: Option<&str>, embedded_file: bool) -> Result<Vec<u8>>;
}

/// Builds the [`Decryptor`] when the trailer has an `/Encrypt` dictionary (`CipherTransformFactory`). The password
/// belongs to the implementation; a wrong or missing one is a [`PdfError::Password`].
pub trait DecryptorFactory: Send + Sync {
    /// `encrypt` is the `/Encrypt` dictionary (its indirect values may be fetched through `xref`), `file_id` the
    /// first element of the trailer's `/ID` (empty when there is none).
    fn create(&self, encrypt: &Dict, file_id: &[u8], xref: &crate::xref::Xref) -> Result<Arc<dyn Decryptor>>;
}

/// The cipher of one object: the document's decryptor and the object's number and generation.
#[derive(Clone)]
pub struct Cipher {
    pub decryptor: Arc<dyn Decryptor>,
    pub num: i64,
    pub generation: i64,
}

/// One filter of a stream's chain.
#[derive(Debug, Clone)]
pub struct FilterSpec {
    pub name: String,
    /// The parameter dictionary, its indirect values resolved.
    pub params: Option<Arc<Dict>>,
}

/// A parsed stream object.
#[derive(Clone)]
pub struct PdfStream {
    pub dict: Arc<Dict>,
    data: Arc<[u8]>,
    start: usize,
    end: usize,
    chain: Vec<FilterSpec>,
    cipher: Option<Cipher>,
    /// The cipher applies to the raw bytes before the chain (the stream has no `Crypt` filter).
    decrypt_first: bool,
    embedded_file: bool,
}

impl fmt::Debug for PdfStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PdfStream").field("raw_len", &(self.end - self.start)).field("chain", &self.chain).finish()
    }
}

impl PdfStream {
    pub(crate) fn new(dict: Arc<Dict>, raw: &ByteStream, chain: Vec<FilterSpec>, cipher: Option<Cipher>, decrypt_first: bool, embedded_file: bool) -> Self {
        PdfStream { dict, data: raw.data().clone(), start: raw.start, end: raw.end.max(raw.start), chain, cipher, decrypt_first, embedded_file }
    }

    /// The bytes between `stream` and `endstream`, as in the file.
    pub fn raw(&self) -> &[u8] {
        &self.data[self.start.min(self.data.len())..self.end.min(self.data.len())]
    }

    /// The filter chain (`/Filter` with `/DecodeParms`).
    pub fn chain(&self) -> &[FilterSpec] {
        &self.chain
    }

    /// The decoded bytes: decrypted, then through each filter. A filter pdf.js does not support leaves the bytes
    /// as they are; a filter that fails (or a zero `/Length` with a filter) leaves the stream empty, as pdf.js's
    /// `NullStream` does. Fatal errors (cancel, budget) propagate.
    pub fn decode(&self, filters: &dyn StreamFilters, guard: &Guard) -> Result<Vec<u8>> {
        guard.check_now()?;
        let max_output = guard.budget().max_bytes;
        let raw = self.raw();
        if self.chain.is_empty() && !self.decrypt_first {
            check_limit(raw.len(), max_output)?;
        }
        let mut bytes = match &self.cipher {
            Some(c) if self.decrypt_first => c.decryptor.decrypt_stream(c.num, c.generation, raw, None, self.embedded_file)?,
            _ => raw.to_vec(),
        };
        if self.decrypt_first || self.chain.is_empty() {
            check_limit(bytes.len(), max_output)?;
        }
        if self.chain.is_empty() {
            return Ok(bytes);
        }
        if raw.is_empty() {
            tracing::warn!("Empty \"{}\" stream.", self.chain[0].name);
            return Ok(Vec::new());
        }
        for (i, spec) in self.chain.iter().enumerate() {
            guard.tick()?;
            if spec.name == "Crypt" {
                let Some(c) = &self.cipher else {
                    tracing::warn!("Filter \"Crypt\" is missing a cipher transform.");
                    continue;
                };
                let name = spec.params.as_ref().and_then(|p| p.get_raw("Name")).and_then(Obj::as_name).unwrap_or("Identity");
                bytes = match c.decryptor.decrypt_stream(c.num, c.generation, &bytes, Some(name), self.embedded_file) {
                    Ok(bytes) => bytes,
                    Err(e) if e.is_fatal() => return Err(e),
                    Err(e) => {
                        tracing::warn!("Invalid stream: \"{e}\"");
                        return Ok(Vec::new());
                    }
                };
                check_limit(bytes.len(), max_output)?;
                continue;
            }
            let length = if i == 0 { Some(raw.len()) } else { None };
            match filters.decode(&spec.name, &bytes, spec.params.as_deref(), length, max_output) {
                Ok(Some(out)) => {
                    if out.len() > max_output {
                        return Err(PdfError::ResourceLimit(format!("decoded stream longer than {max_output} bytes")));
                    }
                    bytes = out;
                }
                Ok(None) => tracing::warn!("Filter \"{}\" is not supported.", spec.name),
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => {
                    tracing::warn!("Invalid stream: \"{e}\"");
                    return Ok(Vec::new());
                }
            }
            check_limit(bytes.len(), max_output)?;
        }
        check_limit(bytes.len(), max_output)?;
        Ok(bytes)
    }
}

fn check_limit(length: usize, limit: usize) -> Result<()> {
    if length > limit { Err(PdfError::ResourceLimit(format!("decoded stream longer than {limit} bytes"))) } else { Ok(()) }
}
