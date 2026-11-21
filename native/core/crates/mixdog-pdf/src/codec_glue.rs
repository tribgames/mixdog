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

use mixdog_pdf_codec::security::{CipherTransform, CipherTransformFactory, CryptFilter, CryptFilterMethod, CryptFilterName, EncryptDict, SecurityError};
use mixdog_pdf_codec::{CodecError, Filter, PredictorParams, decode_chain};

use crate::error::{PdfError, Result};
use crate::object::{Dict, Obj};
use crate::stream::{Decryptor, DecryptorFactory, FilterResult, StreamFilters};
use crate::xref::Xref;

/// The stream filters of the codec crate.
#[derive(Debug, Clone, Copy, Default)]
pub struct CodecFilters;

impl StreamFilters for CodecFilters {
    fn decode(&self, name: &str, data: &[u8], params: Option<&Dict>, _length: Option<usize>, max_output: usize) -> FilterResult {
        let filter = match name {
            "Fl" | "FlateDecode" => Filter::from_name(name, predictor_params(params), None),
            "LZW" | "LZWDecode" => {
                Filter::from_name(name, predictor_params(params), params.and_then(|p| p.get_raw("EarlyChange")).and_then(Obj::as_num).map(|n| n as i64))
            }
            "A85" | "ASCII85Decode" | "AHx" | "ASCIIHexDecode" | "RL" | "RunLengthDecode" => Filter::from_name(name, None, None),
            "BrotliDecode" => return brotli_decode(data, max_output).map(Some),
            "DCT" | "DCTDecode" | "JPX" | "JPXDecode" | "CCF" | "CCITTFaxDecode" | "JBIG2Decode" => {
                if data.len() > max_output {
                    return Err(PdfError::ResourceLimit(format!("decoded stream longer than {max_output} bytes")));
                }
                return Ok(Some(data.to_vec()));
            }
            _ => return Ok(None),
        };
        decode_chain(data, &[filter], max_output).map(Some).map_err(from_codec)
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
    brotli::Decompressor::new(data, 4096).take(limit).read_to_end(&mut out).map_err(|e| PdfError::Format(e.to_string()))?;
    if out.len() > max_output {
        return Err(PdfError::ResourceLimit(format!("decoded stream longer than {max_output} bytes")));
    }
    Ok(out)
}

fn from_codec(error: CodecError) -> PdfError {
    match error {
        CodecError::Format(message) => PdfError::Format(message),
        CodecError::ResourceLimit { limit } => PdfError::ResourceLimit(format!("decoded stream longer than {limit} bytes")),
    }
}

fn from_security(error: SecurityError) -> PdfError {
    match error {
        SecurityError::Password { code, message } => PdfError::Password { message: message.to_owned(), code },
        SecurityError::Format(message) => PdfError::Format(message),
        SecurityError::ResourceLimit { limit } => PdfError::ResourceLimit(format!("decrypted stream longer than {limit} bytes")),
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
        CodecDecryptorFactory { password, max_bytes }
    }
}

impl DecryptorFactory for CodecDecryptorFactory {
    fn create(&self, encrypt: &Dict, file_id: &[u8], xref: &Xref) -> Result<Arc<dyn Decryptor>> {
        let (mut dict, cf) = encrypt_dict(xref, encrypt)?;
        let cf_missing = !encrypt.has("CF");
        let factory = match CipherTransformFactory::new(&dict, file_id, self.password.as_deref()) {
            Err(SecurityError::Password { code: 1, .. }) if dict.v.is_some_and(|v| v >= 4) && is_identity(&dict.stm_f) && is_identity(&dict.str_f) => {
                // AuthEvent is read only on the no-password EFOpen path, after key derivation fails.
                let eff = dict.eff.as_ref().or(dict.stm_f.as_ref());
                let name = match eff {
                    Some(CryptFilterName::Name(n)) => n.as_str(),
                    None => "Identity",
                    _ => "",
                };
                let handler = if matches!(cf, Obj::Null) {
                    Obj::Null
                } else if matches!(cf, Obj::Dict(_)) {
                    // A non-Name's .name is undefined, not the empty PDF Name.
                    // Map.get(undefined) misses even when the dictionary has /.
                    if matches!(eff, Some(CryptFilterName::Invalid)) { Obj::Null } else { cf_handler(xref, &cf, name, cf_missing)? }
                } else {
                    return Err(PdfError::Format("this.cf?.get is not a function".into()));
                };
                let auth_event = match handler {
                    Obj::Null => None,
                    Obj::Dict(handler) => name_of(&xref.get(&handler, "AuthEvent")?),
                    _ => {
                        return Err(PdfError::Format("effCF?.get is not a function".into()));
                    }
                };
                dict.cf = Some(vec![(name.to_owned(), CryptFilter { auth_event, ..Default::default() })]);
                CipherTransformFactory::new(&dict, file_id, self.password.as_deref()).map_err(from_security)?
            }
            result => result.map_err(from_security)?,
        };
        Ok(Arc::new(CodecDecryptor { factory: Arc::new(factory), cf, max_bytes: self.max_bytes, cf_missing, transform: None }))
    }
}

/// The strings and streams of one document, decrypted per object number and generation.
struct CodecDecryptor {
    factory: Arc<CipherTransformFactory>,
    cf: Obj,
    max_bytes: usize,
    cf_missing: bool,
    transform: Option<CipherTransform>,
}
impl CodecDecryptor {
    fn transform(&self, num: i64, generation: i64) -> CipherTransform {
        self.transform.clone().unwrap_or_else(|| self.factory.create_cipher_transform(num as u32, generation as u32))
    }
    fn prepare(&self, num: i64, generation: i64, explicit: Option<&str>, embedded: bool, string: bool, xref: Option<&Xref>) -> Result<CipherTransform> {
        let transform = self.transform(num, generation);
        if !transform.uses_crypt_filters() || transform.has_cached_constructor(string, explicit, embedded) {
            return Ok(transform);
        }
        let name = if string {
            transform.string_filter_name().map_err(from_security)?
        } else if let Some(name) = explicit {
            Some(name)
        } else {
            transform.stream_filter_name(embedded).map_err(from_security)?
        };
        let name = name.expect("version 4/5 has a selected crypt filter");
        let xref = xref.ok_or_else(|| PdfError::Format("Crypt filter resolution requires an xref.".into()))?;
        let handler = cf_handler(xref, &self.cf, name, self.cf_missing)?;
        let filter = crypt_filter(xref, &handler)?;
        Ok(transform.clone().with_crypt_filters(vec![(name.to_owned(), filter)]))
    }
}
impl Decryptor for CodecDecryptor {
    fn for_object(&self, num: i64, generation: i64) -> Option<Arc<dyn Decryptor>> {
        Some(Arc::new(Self {
            factory: self.factory.clone(),
            cf: self.cf.clone(),
            cf_missing: self.cf_missing,
            max_bytes: self.max_bytes,
            transform: Some(self.factory.create_cipher_transform(num as u32, generation as u32)),
        }))
    }
    fn uses_embedded_filter(&self) -> bool {
        self.factory.create_cipher_transform(0, 0).uses_crypt_filters()
    }
    fn decrypt_string(&self, num: i64, generation: i64, data: &[u8], xref: Option<&Xref>) -> Result<Vec<u8>> {
        self.prepare(num, generation, None, false, true, xref)?.decrypt_string(data).map_err(from_security)
    }
    fn validate_stream(&self, num: i64, generation: i64, crypt_name: Option<&str>, embedded_file: bool, xref: Option<&Xref>) -> Result<()> {
        let transform = self.prepare(num, generation, crypt_name, embedded_file, false, xref)?;
        transform.validate_stream(crypt_name, embedded_file).map_err(from_security)?;
        Ok(())
    }
    fn decrypt_stream(&self, num: i64, generation: i64, data: &[u8], crypt_name: Option<&str>, embedded_file: bool) -> Result<Vec<u8>> {
        let transform = self.transform(num, generation);
        transform.decrypt_stream(data, crypt_name, embedded_file, self.max_bytes).map_err(from_security)
    }
}
fn is_identity(name: &Option<CryptFilterName>) -> bool {
    name.is_none() || matches!(name, Some(CryptFilterName::Name(n)) if n == "Identity")
}
fn cf_handler(xref: &Xref, cf: &Obj, name: &str, missing: bool) -> Result<Obj> {
    let Obj::Dict(cf) = cf else {
        return Err(PdfError::Format(
            match cf {
                Obj::Null if missing => "Cannot read properties of undefined (reading 'get')",
                Obj::Null => "Cannot read properties of null (reading 'get')",
                _ => "this.cf.get is not a function",
            }
            .into(),
        ));
    };
    let mut cf = (**cf).clone();
    cf.suppress_encryption = true;
    xref.get(&cf, name)
}

fn selector(obj: &Obj) -> Option<CryptFilterName> {
    if is_falsy(obj) {
        None
    } else {
        Some(match obj.as_name() {
            Some(name) => CryptFilterName::from(name),
            None => CryptFilterName::Invalid,
        })
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
fn encrypt_dict(xref: &Xref, encrypt: &Dict) -> Result<(EncryptDict, Obj)> {
    let cf_missing = !encrypt.has("CF");
    let get = |key: &str| xref.get(encrypt, key);
    let filter = name_of(&get("Filter")?);
    if filter.as_deref() != Some("Standard") {
        return Err(PdfError::Format("unknown encryption method".into()));
    }
    let v = get("V")?.as_int();
    if !matches!(v, Some(1 | 2 | 4 | 5)) {
        return Err(PdfError::Format("unsupported encryption algorithm".into()));
    }
    let length_obj = get("Length")?;
    let mut length = if is_falsy(&length_obj) { 0 } else { length_obj.as_int().unwrap_or(-1) };
    if length != 0 && (length < 40 || length % 8 != 0) {
        return Err(PdfError::Format("invalid key length".into()));
    }
    let cf = if v.unwrap() >= 4 { get("CF")? } else { Obj::Null };
    let stm_value = if v.unwrap() >= 4 { get("StmF")? } else { Obj::Null };
    if length == 0 {
        length = default_key_length(xref, v.unwrap(), &cf, &stm_value, cf_missing)?;
    }
    if length < 40 || length % 8 != 0 {
        return Err(PdfError::Format("invalid key length".into()));
    }
    let stm_f = selector(&stm_value);
    let str_f = if v.unwrap() >= 4 { selector(&get("StrF")?) } else { None };
    let eff = if v.unwrap() >= 4 { selector(&get("EFF")?) } else { None };
    let o = bytes_of(&get("O")?);
    let u = bytes_of(&get("U")?);
    let p = get("P")?.as_num().map_or(0, |n| n as i64);
    let r = get("R")?.as_int();
    let encrypt_metadata = if v.unwrap() >= 4 {
        match get("EncryptMetadata")? {
            Obj::Bool(b) => Some(b),
            _ => None,
        }
    } else {
        None
    };
    let (oe, ue, perms) =
        if v == Some(5) { (bytes_of(&get("OE")?), bytes_of(&get("UE")?), bytes_of(&get("Perms")?)) } else { (Vec::new(), Vec::new(), Vec::new()) };
    Ok((
        EncryptDict {
            filter,
            v,
            r,
            length: Some(length),
            o,
            u,
            oe,
            ue,
            perms,
            p,
            encrypt_metadata,
            cf: matches!(cf, Obj::Dict(_)).then(Vec::new),
            stm_f,
            str_f,
            eff,
        },
        cf,
    ))
}

/// The key length of an `/Encrypt` dictionary without a `Length`: 40 bits up to version 3, else the `Length` of the
/// `StmF` crypt filter (in bytes when below 40), 0 when version 4/5 names no usable crypt filter.
fn default_key_length(xref: &Xref, v: i64, cf: &Obj, stm_value: &Obj, cf_missing: bool) -> Result<i64> {
    if v <= 3 {
        return Ok(40);
    }
    let (Obj::Dict(_), Some(name)) = (cf, stm_value.as_name()) else {
        return Ok(0);
    };
    let value = match cf_handler(xref, cf, name, cf_missing)? {
        Obj::Null => Obj::Null,
        Obj::Dict(handler) => xref.get(&handler, "Length")?,
        _ => return Err(PdfError::Format("handlerDict?.get is not a function".into())),
    };
    let value = if is_falsy(&value) { Obj::Num(128.0) } else { value };
    let numeric = crate::page::object_number(&value);
    if numeric < 40.0 {
        // JavaScript's <<= 3 first performs ToInt32, including numeric strings/arrays.
        let bits = if numeric.is_finite() { numeric.trunc().rem_euclid(4_294_967_296.0) as u32 } else { 0 };
        Ok(i64::from(bits.wrapping_shl(3) as i32))
    } else {
        Ok(value.as_int().unwrap_or(-1))
    }
}

/// One entry of the `CF` dictionary. A `CFM` that is missing (or falsy) is the identity, one that is no name is an
/// unknown method.
fn crypt_filter(xref: &Xref, handler: &Obj) -> Result<CryptFilter> {
    if matches!(handler, Obj::Null) {
        return Ok(CryptFilter::default());
    }
    let Obj::Dict(handler) = handler else {
        return Err(PdfError::Format("cryptFilter?.get is not a function".into()));
    };
    let cfm = match xref.get(handler, "CFM")? {
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
    Ok(CryptFilter { cfm, ..Default::default() })
}
