//! The codec crate behind the seams of the structure layer: [`CodecFilters`] decodes the stream filters
//! ([`StreamFilters`]) and [`CodecDecryptorFactory`] opens an encrypted document with the password and hands out the
//! [`Decryptor`] of its strings and streams ([`DecryptorFactory`]). [`crate::Document::open`] installs both.
//!
//! Filters as pdf.js's `makeFilter` treats them: `FlateDecode` and `LZWDecode` apply the predictor of their
//! `DecodeParms`, `ASCII85Decode`, `ASCIIHexDecode`, `RunLengthDecode` and `BrotliDecode` decode, the image codecs
//! (`DCTDecode`, `JPXDecode`, `CCITTFaxDecode`, `JBIG2Decode`) produce pixels for a renderer and leave the bytes as
//! they are here (nothing of the read path decodes an image), and a name pdf.js does not know is `Ok(None)`.

use std::io::Read;
use std::sync::Arc;

use mixdog_pdf_codec::security::{
    CipherTransformFactory, CryptFilter, CryptFilterMethod, EncryptDict, SecurityError,
};
use mixdog_pdf_codec::{CodecError, Filter, PredictorParams, decode_chain};

use crate::error::{PdfError, Result};
use crate::object::{Dict, Obj};
use crate::stream::{Decryptor, DecryptorFactory, FilterResult, StreamFilters};
use crate::xref::Xref;

/// The stream filters of the codec crate.
#[derive(Debug, Clone, Copy, Default)]
pub struct CodecFilters;

impl StreamFilters for CodecFilters {
    fn decode(
        &self,
        name: &str,
        data: &[u8],
        params: Option<&Dict>,
        _length: Option<usize>,
        max_output: usize,
    ) -> FilterResult {
        let filter = match name {
            "Fl" | "FlateDecode" => Filter::from_name(name, predictor_params(params), None),
            "LZW" | "LZWDecode" => Filter::from_name(
                name,
                predictor_params(params),
                params
                    .and_then(|p| p.get_raw("EarlyChange"))
                    .and_then(Obj::as_num)
                    .map(|n| n as i64),
            ),
            "A85" | "ASCII85Decode" | "AHx" | "ASCIIHexDecode" | "RL" | "RunLengthDecode" => {
                Filter::from_name(name, None, None)
            }
            "BrotliDecode" => return brotli_decode(data, max_output).map(Some),
            "DCT" | "DCTDecode" | "JPX" | "JPXDecode" | "CCF" | "CCITTFaxDecode"
            | "JBIG2Decode" => return Ok(Some(data.to_vec())),
            _ => return Ok(None),
        };
        decode_chain(data, &[filter], max_output)
            .map(Some)
            .map_err(from_codec)
    }
}

/// The `Predictor`, `Colors`, `BitsPerComponent` (`BPC`) and `Columns` of a `DecodeParms` dictionary; 0 stands for
/// "not given" (pdf.js reads each with `|| default`). `None` without a dictionary: no predictor stream.
fn predictor_params(params: Option<&Dict>) -> Option<PredictorParams> {
    let int = |obj: Option<&Obj>| obj.and_then(Obj::as_num).map_or(0, |n| n as i64);
    params.map(|p| PredictorParams {
        predictor: int(p.get_raw("Predictor")),
        colors: int(p.get_raw("Colors")),
        bits_per_component: int(p.get_raw2("BPC", "BitsPerComponent")),
        columns: int(p.get_raw("Columns")),
    })
}

/// `BrotliStream`: the whole stream is one Brotli data. The decoder stops one byte past `max_output`, so the caller
/// sees that the limit was passed.
fn brotli_decode(data: &[u8], max_output: usize) -> Result<Vec<u8>> {
    let limit = u64::try_from(max_output).unwrap_or(u64::MAX).saturating_add(1);
    let mut out = Vec::new();
    brotli::Decompressor::new(data, 4096)
        .take(limit)
        .read_to_end(&mut out)
        .map_err(|e| PdfError::Format(e.to_string()))?;
    Ok(out)
}

fn from_codec(error: CodecError) -> PdfError {
    match error {
        CodecError::Format(message) => PdfError::Format(message),
    }
}

fn from_security(error: SecurityError) -> PdfError {
    match error {
        SecurityError::Password { code, message } => PdfError::Password {
            message: message.to_owned(),
            code,
        },
        SecurityError::Format(message) => PdfError::Format(message),
    }
}

/// Opens an encrypted document (`CipherTransformFactory`) with the password of the reader's options.
#[derive(Debug, Clone)]
pub struct CodecDecryptorFactory {
    password: Option<String>,
    max_bytes: usize,
}

impl CodecDecryptorFactory {
    /// `max_bytes` bounds what one decrypted stream may produce.
    pub fn new(password: Option<String>, max_bytes: usize) -> Self {
        CodecDecryptorFactory {
            password,
            max_bytes,
        }
    }
}

impl DecryptorFactory for CodecDecryptorFactory {
    fn create(
        &self,
        encrypt: &Dict,
        file_id: &[u8],
        xref: &Xref,
    ) -> Result<Arc<dyn Decryptor>> {
        let dict = encrypt_dict(xref, encrypt)?;
        let factory = CipherTransformFactory::new(&dict, file_id, self.password.as_deref())
            .map_err(from_security)?;
        Ok(Arc::new(CodecDecryptor {
            factory,
            max_bytes: self.max_bytes,
        }))
    }
}

/// The strings and streams of one document, decrypted per object number and generation.
struct CodecDecryptor {
    factory: CipherTransformFactory,
    max_bytes: usize,
}

impl Decryptor for CodecDecryptor {
    fn decrypt_string(&self, num: i64, generation: i64, data: &[u8]) -> Vec<u8> {
        let transform = self
            .factory
            .create_cipher_transform(num as u32, generation as u32);
        match transform.decrypt_string(data) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::warn!("Cannot decrypt the string of object {num}: \"{e}\".");
                Vec::new()
            }
        }
    }

    fn decrypt_stream(
        &self,
        num: i64,
        generation: i64,
        data: &[u8],
        crypt_name: Option<&str>,
    ) -> Result<Vec<u8>> {
        self.factory
            .create_cipher_transform(num as u32, generation as u32)
            .decrypt_stream(data, crypt_name, false, self.max_bytes)
            .map_err(from_security)
    }
}

/// `dict.get(key)`, where a failure other than a fatal one reads as a missing value.
fn soft_get(xref: &Xref, dict: &Dict, key: &str) -> Result<Obj> {
    match xref.get(dict, key) {
        Err(e) if !e.is_fatal() => Ok(Obj::Null),
        other => other,
    }
}

fn name_of(obj: &Obj) -> Option<String> {
    obj.as_name().map(str::to_owned)
}

fn bytes_of(obj: &Obj) -> Vec<u8> {
    obj.as_str().map(<[u8]>::to_vec).unwrap_or_default()
}

/// A value JavaScript reads as false (`!value`): missing, `null`, `false`, 0, NaN and the empty string.
fn is_falsy(obj: &Obj) -> bool {
    match obj {
        Obj::Null | Obj::Bool(false) => true,
        Obj::Num(n) => *n == 0.0 || n.is_nan(),
        Obj::Str(s) => s.is_empty(),
        _ => false,
    }
}

/// The values the standard security handler reads out of the `/Encrypt` dictionary (`CipherTransformFactory`'s
/// constructor). A `Length` that is not falsy and not an integer is handed over as -1, which the handler rejects as
/// pdf.js does (`invalid key length`).
fn encrypt_dict(xref: &Xref, encrypt: &Dict) -> Result<EncryptDict> {
    let get = |key: &str| soft_get(xref, encrypt, key);
    let length = match get("Length")? {
        value if is_falsy(&value) => None,
        value => Some(value.as_int().unwrap_or(-1)),
    };
    let cf = match get("CF")? {
        Obj::Dict(cf) => {
            let mut cf = (*cf).clone();
            cf.suppress_encryption = true;
            let keys: Vec<String> = cf.keys().map(str::to_owned).collect();
            let mut filters = Vec::with_capacity(keys.len());
            for key in keys {
                let handler = soft_get(xref, &cf, &key)?;
                filters.push((key, crypt_filter(xref, &handler)?));
            }
            Some(filters)
        }
        _ => None,
    };
    Ok(EncryptDict {
        filter: name_of(&get("Filter")?),
        v: get("V")?.as_int(),
        r: get("R")?.as_int(),
        length,
        o: bytes_of(&get("O")?),
        u: bytes_of(&get("U")?),
        oe: bytes_of(&get("OE")?),
        ue: bytes_of(&get("UE")?),
        perms: bytes_of(&get("Perms")?),
        p: get("P")?.as_num().map_or(0, |n| n as i64),
        encrypt_metadata: match get("EncryptMetadata")? {
            Obj::Bool(b) => Some(b),
            _ => None,
        },
        cf,
        stm_f: name_of(&get("StmF")?),
        str_f: name_of(&get("StrF")?),
        eff: name_of(&get("EFF")?),
    })
}

/// One entry of the `CF` dictionary. A `CFM` that is missing (or falsy) is the identity, one that is no name is an
/// unknown method.
fn crypt_filter(xref: &Xref, handler: &Obj) -> Result<CryptFilter> {
    let Obj::Dict(handler) = handler else {
        return Ok(CryptFilter::default());
    };
    let cfm = match soft_get(xref, handler, "CFM")? {
        value if is_falsy(&value) => None,
        Obj::Name(name) => Some(match &*name {
            "None" => CryptFilterMethod::None,
            "V2" => CryptFilterMethod::V2,
            "AESV2" => CryptFilterMethod::AesV2,
            "AESV3" => CryptFilterMethod::AesV3,
            other => CryptFilterMethod::Other(other.to_owned()),
        }),
        _ => Some(CryptFilterMethod::Other(String::new())),
    };
    Ok(CryptFilter {
        cfm,
        length: soft_get(xref, handler, "Length")?.as_int(),
        auth_event: name_of(&soft_get(xref, handler, "AuthEvent")?),
    })
}
