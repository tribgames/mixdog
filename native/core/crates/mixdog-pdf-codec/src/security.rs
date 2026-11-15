//! The standard security handler of pdf.js (`CipherTransformFactory`, `CipherTransform`, `PDF17`, `PDF20`, the RC4
//! and AES ciphers of `crypto.js`, `DecryptStream`), as plain functions over the values of the `Encrypt` dictionary.
//!
//! Revisions 2 to 4 derive the key with MD5 and RC4 rounds, revision 5 with SHA-256, revision 6 with the ISO 32000-2
//! hash (SHA-256, SHA-384 and SHA-512 over AES-128-CBC rounds). The empty password is tried first, then the given
//! one as the user password and then as the owner password, the way pdf.js does. The outcomes of pdf.js's
//! `PasswordException` are [`SecurityError::Password`] with code 1 (`No password given`) or 2 (`Incorrect Password`).
//!
//! Strings and streams decrypt per object number and generation. The AES decryptor keeps pdf.js's behaviour on
//! damaged data: the 16 bytes of the IV come first, a trailing partial block is dropped, and the padding of the last
//! block is removed only when its bytes agree with their own count.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::{Aes128, Aes256};
use md5::{Digest, Md5};
use sha2::{Sha256, Sha384, Sha512};
use unicode_normalization::UnicodeNormalization;

use crate::rc4::Rc4;

/// `PasswordResponses.NEED_PASSWORD`.
pub const NEED_PASSWORD: u8 = 1;
/// `PasswordResponses.INCORRECT_PASSWORD`.
pub const INCORRECT_PASSWORD: u8 = 2;

const DEFAULT_PASSWORD_BYTES: [u8; 32] = [
    0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
    0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
];

/// Why a document could not be opened or a string or stream could not be decrypted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecurityError {
    /// pdf.js's `PasswordException`: `code` is [`NEED_PASSWORD`] or [`INCORRECT_PASSWORD`].
    Password {
        code: u8,
        message: &'static str,
    },
    /// pdf.js's `FormatError`.
    Format(String),
    ResourceLimit {
        limit: usize,
    },
}

impl SecurityError {
    fn need_password() -> Self {
        SecurityError::Password { code: NEED_PASSWORD, message: "No password given" }
    }

    fn incorrect_password() -> Self {
        SecurityError::Password { code: INCORRECT_PASSWORD, message: "Incorrect Password" }
    }
}

impl fmt::Display for SecurityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecurityError::Password { message, .. } => f.write_str(message),
            SecurityError::Format(message) => f.write_str(message),
            SecurityError::ResourceLimit { limit } => {
                write!(f, "decrypted stream longer than {limit} bytes")
            }
        }
    }
}

impl std::error::Error for SecurityError {}

/// `CFM` of a crypt filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptFilterMethod {
    None,
    V2,
    AesV2,
    AesV3,
    /// Any other name: using the filter is a format error.
    Other(String),
}

/// One entry of the `CF` dictionary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CryptFilter {
    /// `None` when the entry has no `CFM`; pdf.js treats that as the identity.
    pub cfm: Option<CryptFilterMethod>,
    pub length: Option<i64>,
    pub auth_event: Option<String>,
}

/// The values of the `Encrypt` dictionary the standard handler reads. Names are given as text, strings as bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EncryptDict {
    /// `Filter`.
    pub filter: Option<String>,
    /// `V`.
    pub v: Option<i64>,
    /// `R`.
    pub r: Option<i64>,
    /// `Length` (bits).
    pub length: Option<i64>,
    pub o: Vec<u8>,
    pub u: Vec<u8>,
    pub oe: Vec<u8>,
    pub ue: Vec<u8>,
    /// Read by nothing: pdf.js does not check it either.
    pub perms: Vec<u8>,
    /// `P`.
    pub p: i64,
    /// `EncryptMetadata`; absent reads as true.
    pub encrypt_metadata: Option<bool>,
    /// `CF` as `(name, filter)` pairs; `None` when the dictionary has no `CF`.
    pub cf: Option<Vec<(String, CryptFilter)>>,
    pub stm_f: Option<CryptFilterName>,
    pub str_f: Option<CryptFilterName>,
    pub eff: Option<CryptFilterName>,
}

/// A truthy non-Name must survive dictionary conversion until the cipher is selected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptFilterName {
    Name(String),
    Invalid,
}
impl From<String> for CryptFilterName {
    fn from(value: String) -> Self {
        Self::Name(value)
    }
}
impl From<&str> for CryptFilterName {
    fn from(value: &str) -> Self {
        Self::Name(value.into())
    }
}
impl CryptFilterName {
    fn name(&self) -> Option<&str> {
        match self {
            Self::Name(name) => Some(name),
            Self::Invalid => None,
        }
    }
    fn is_identity(&self) -> bool {
        self.name() == Some("Identity")
    }
}

fn lookup<'a>(cf: &'a [(String, CryptFilter)], name: &str) -> Option<&'a CryptFilter> {
    cf.iter().find(|(n, _)| n == name).map(|(_, f)| f)
}

fn md5(data: &[u8]) -> Vec<u8> {
    Md5::digest(data).to_vec()
}

fn sha256(data: &[u8]) -> Vec<u8> {
    Sha256::digest(data).to_vec()
}

// ---------------------------------------------------------------------------------------------------------------
// AES

enum AesKey {
    Aes128(Aes128),
    Aes256(Aes256),
}

impl AesKey {
    /// A key shorter than the size is padded with zeros and a longer one cut, as pdf.js's key expansion does.
    fn new(key: &[u8], size: usize) -> Self {
        let mut fitted = vec![0u8; size];
        let n = key.len().min(size);
        fitted[..n].copy_from_slice(&key[..n]);
        if size == 16 {
            AesKey::Aes128(Aes128::new(GenericArray::from_slice(&fitted)))
        } else {
            AesKey::Aes256(Aes256::new(GenericArray::from_slice(&fitted)))
        }
    }

    fn decrypt(&self, block: &mut [u8; 16]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            AesKey::Aes128(c) => c.decrypt_block(b),
            AesKey::Aes256(c) => c.decrypt_block(b),
        }
    }

    fn encrypt(&self, block: &mut [u8; 16]) {
        let b = GenericArray::from_mut_slice(block);
        match self {
            AesKey::Aes128(c) => c.encrypt_block(b),
            AesKey::Aes256(c) => c.encrypt_block(b),
        }
    }
}

/// AES-CBC decryption with pdf.js's framing: the first 16 bytes are the IV unless one is given.
struct AesDecryptor {
    key: AesKey,
    iv: Option<[u8; 16]>,
}

impl AesDecryptor {
    fn new(key: &[u8], size: usize) -> Self {
        AesDecryptor { key: AesKey::new(key, size), iv: None }
    }

    /// `decryptBlock(data, finalize)`. While the IV has not been read, fewer than 16 bytes give nothing.
    fn decrypt_block(&mut self, data: &[u8], finalize: bool) -> Vec<u8> {
        let data = if self.iv.is_none() {
            let Some(first) = data.first_chunk::<16>() else {
                return Vec::new();
            };
            self.iv = Some(*first);
            &data[16..]
        } else {
            data
        };
        self.decrypt_blocks(data, finalize)
    }

    /// `decryptBlock(data, false, iv)`: the data has no IV prefix.
    fn decrypt_with_iv(&mut self, data: &[u8], iv: [u8; 16]) -> Vec<u8> {
        self.iv = Some(iv);
        self.decrypt_blocks(data, false)
    }

    /// pdf.js loses a partial block at the end of a call (its position is never stored), so only whole blocks count.
    fn decrypt_blocks(&mut self, data: &[u8], finalize: bool) -> Vec<u8> {
        let mut iv = self.iv.unwrap_or([0; 16]);
        let mut out = Vec::with_capacity(data.len());
        for chunk in data.chunks_exact(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            let cipher_block = block;
            self.key.decrypt(&mut block);
            for (b, v) in block.iter_mut().zip(iv) {
                *b ^= v;
            }
            out.extend_from_slice(&block);
            iv = cipher_block;
        }
        self.iv = Some(iv);
        if finalize && !out.is_empty() {
            let last = out.len() - 16;
            let mut padding = usize::from(out[last + 15]);
            if padding <= 16 {
                let tail_start = 16 - padding;
                if out[last + tail_start..last + 16].iter().any(|&b| usize::from(b) != padding) {
                    padding = 0;
                }
                out.truncate(out.len() - padding);
            }
        }
        out
    }
}

/// AES-128-CBC encryption without padding, for the revision 6 hash (`AESBaseCipher.encrypt`).
fn aes128_cbc_encrypt(key: &[u8], data: &[u8], iv: &[u8]) -> Vec<u8> {
    let cipher = AesKey::new(key, 16);
    let mut chain = [0u8; 16];
    let n = iv.len().min(16);
    chain[..n].copy_from_slice(&iv[..n]);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks_exact(16) {
        let mut block = [0u8; 16];
        for (slot, (c, v)) in block.iter_mut().zip(chunk.iter().zip(chain)) {
            *slot = c ^ v;
        }
        cipher.encrypt(&mut block);
        out.extend_from_slice(&block);
        chain = block;
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Ciphers

enum Cipher {
    Null,
    Rc4(Rc4),
    Aes(AesDecryptor),
}

impl Cipher {
    fn decrypt_block(&mut self, data: &[u8], finalize: bool) -> Vec<u8> {
        match self {
            Cipher::Null => data.to_vec(),
            Cipher::Rc4(rc4) => rc4.apply(data),
            Cipher::Aes(aes) => aes.decrypt_block(data, finalize),
        }
    }
}

#[derive(Clone)]
enum CipherKind {
    Null,
    Rc4(Vec<u8>),
    Aes128(Vec<u8>),
    Aes256(Vec<u8>),
}

impl CipherKind {
    fn instantiate(&self) -> Cipher {
        match self {
            CipherKind::Null => Cipher::Null,
            CipherKind::Rc4(key) => Cipher::Rc4(Rc4::new(key)),
            CipherKind::Aes128(key) => Cipher::Aes(AesDecryptor::new(key, 16)),
            CipherKind::Aes256(key) => Cipher::Aes(AesDecryptor::new(key, 32)),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Revision 5 and 6 password hashes

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pdf2 {
    /// Revision 5.
    Pdf17,
    /// Revision 6.
    Pdf20,
}

impl Pdf2 {
    fn hash(self, password: &[u8], input: &[u8], user_bytes: &[u8]) -> Vec<u8> {
        match self {
            Pdf2::Pdf17 => sha256(input),
            Pdf2::Pdf20 => hash_pdf20(password, input, user_bytes),
        }
    }

    /// `password` followed by `salt` and, for the owner check, `user_bytes`, in a zero filled buffer of `len` bytes
    /// after the password. A part that does not fit is cut.
    fn hash_input(password: &[u8], len: usize, parts: &[&[u8]]) -> Vec<u8> {
        let mut data = vec![0u8; password.len() + len];
        data[..password.len()].copy_from_slice(password);
        let mut at = password.len();
        for part in parts {
            let n = part.len().min(data.len() - at);
            data[at..at + n].copy_from_slice(&part[..n]);
            at += part.len();
            if at >= data.len() {
                break;
            }
        }
        data
    }

    fn check_owner_password(
        self,
        password: &[u8],
        validation_salt: &[u8],
        user_bytes: &[u8],
        owner_password: &[u8],
    ) -> bool {
        let data = Self::hash_input(password, 56, &[validation_salt, user_bytes]);
        self.hash(password, &data, user_bytes) == owner_password
    }

    fn check_user_password(self, password: &[u8], validation_salt: &[u8], user_password: &[u8]) -> bool {
        let data = Self::hash_input(password, 8, &[validation_salt]);
        self.hash(password, &data, &[]) == user_password
    }

    fn owner_key(self, password: &[u8], key_salt: &[u8], user_bytes: &[u8], owner_encryption: &[u8]) -> Vec<u8> {
        let data = Self::hash_input(password, 56, &[key_salt, user_bytes]);
        let key = self.hash(password, &data, user_bytes);
        AesDecryptor::new(&key, 32).decrypt_with_iv(owner_encryption, [0; 16])
    }

    fn user_key(self, password: &[u8], key_salt: &[u8], user_encryption: &[u8]) -> Vec<u8> {
        let data = Self::hash_input(password, 8, &[key_salt]);
        let key = self.hash(password, &data, &[]);
        AesDecryptor::new(&key, 32).decrypt_with_iv(user_encryption, [0; 16])
    }
}

/// The ISO 32000-2 hash (algorithm 2.B).
fn hash_pdf20(password: &[u8], input: &[u8], user_bytes: &[u8]) -> Vec<u8> {
    let mut k = sha256(input);
    let mut last_byte: u8 = 0;
    let mut i: usize = 0;
    while i < 64 || usize::from(last_byte) > i - 32 {
        let mut combined = Vec::with_capacity(password.len() + k.len() + user_bytes.len());
        combined.extend_from_slice(password);
        combined.extend_from_slice(&k);
        combined.extend_from_slice(user_bytes);
        let k1 = combined.repeat(64);
        let e = aes128_cbc_encrypt(&k[..16], &k1, &k[16..32]);
        let remainder = e[..16].iter().map(|&b| u32::from(b)).sum::<u32>() % 3;
        k = match remainder {
            0 => Sha256::digest(&e).to_vec(),
            1 => Sha384::digest(&e).to_vec(),
            _ => Sha512::digest(&e).to_vec(),
        };
        last_byte = e.last().copied().unwrap_or(0);
        i += 1;
    }
    k.truncate(32);
    k
}

fn sasl_prep(password: &str) -> String {
    const NON_ASCII_SPACES: [u32; 17] = [
        0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b,
        0x202f, 0x205f, 0x3000,
    ];
    const COMMONLY_MAPPED_TO_NOTHING: [u32; 27] = [
        0x00ad, 0x034f, 0x1806, 0x180b, 0x180c, 0x180d, 0x200b, 0x200c, 0x200d, 0x2060, 0xfe00, 0xfe01, 0xfe02, 0xfe03,
        0xfe04, 0xfe05, 0xfe06, 0xfe07, 0xfe08, 0xfe09, 0xfe0a, 0xfe0b, 0xfe0c, 0xfe0d, 0xfe0e, 0xfe0f, 0xfeff,
    ];
    let mut mapped = String::new();
    for ch in password.chars() {
        let code = u32::from(ch);
        if NON_ASCII_SPACES.contains(&code) {
            mapped.push(' ');
        } else if !COMMONLY_MAPPED_TO_NOTHING.contains(&code) {
            mapped.push(ch);
        }
    }
    mapped.nfkc().collect()
}

/// `stringToBytes`: each UTF-16 code unit's low byte.
fn latin1_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16().map(|unit| (unit & 0xff) as u8).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// The factory

fn build_object_key(num: u32, generation: u32, encryption_key: &[u8], is_aes: bool) -> Vec<u8> {
    let n = encryption_key.len();
    let mut key = Vec::with_capacity(n + 9);
    key.extend_from_slice(encryption_key);
    key.extend_from_slice(&[num as u8, (num >> 8) as u8, (num >> 16) as u8, generation as u8, (generation >> 8) as u8]);
    if is_aes {
        key.extend_from_slice(&[0x73, 0x41, 0x6c, 0x54]);
    }
    let mut hash = md5(&key);
    hash.truncate((n + 5).min(16));
    hash
}

/// The key of the document and what is needed to decrypt its objects (`CipherTransformFactory`).
#[derive(Clone)]
pub struct CipherTransformFactory {
    dict: EncryptDict,
    file_id: Vec<u8>,
    algorithm: i64,
    encrypt_metadata: bool,
    stm_f: CryptFilterName,
    str_f: CryptFilterName,
    eff: CryptFilterName,
    cf: Option<Vec<(String, CryptFilter)>>,
    encryption_key: Option<Vec<u8>>,
}

impl fmt::Debug for CipherTransformFactory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The key stays out of any log line.
        f.debug_struct("CipherTransformFactory").field("algorithm", &self.algorithm).finish_non_exhaustive()
    }
}

impl CipherTransformFactory {
    /// Opens the document with `password` (`None` or empty: the empty user password). Fails with
    /// [`SecurityError::Password`] when the password does not open it.
    pub fn new(dict: &EncryptDict, file_id: &[u8], password: Option<&str>) -> Result<Self, SecurityError> {
        let password = password.filter(|p| !p.is_empty());
        if dict.filter.as_deref() != Some("Standard") {
            return Err(SecurityError::Format("unknown encryption method".into()));
        }
        let algorithm = match dict.v {
            Some(v @ (1 | 2 | 4 | 5)) => v,
            _ => {
                return Err(SecurityError::Format("unsupported encryption algorithm".into()));
            }
        };
        let mut key_length = dict.length.unwrap_or(0);
        if key_length == 0 {
            if algorithm <= 3 {
                key_length = 40;
            } else if let (Some(cf), Some(CryptFilterName::Name(stm_f))) = (&dict.cf, &dict.stm_f) {
                key_length = lookup(cf, stm_f).and_then(|f| f.length).filter(|&l| l != 0).unwrap_or(128);
                if key_length < 40 {
                    key_length <<= 3;
                }
            }
        }
        if key_length < 40 || key_length % 8 != 0 {
            return Err(SecurityError::Format("invalid key length".into()));
        }
        let identity = || CryptFilterName::from("Identity");
        let (cf, stm_f, str_f, eff) = if algorithm >= 4 {
            let stm_f = dict.stm_f.clone().unwrap_or_else(identity);
            let str_f = dict.str_f.clone().unwrap_or_else(identity);
            let eff = dict.eff.clone().unwrap_or_else(|| stm_f.clone());
            (dict.cf.clone(), stm_f, str_f, eff)
        } else {
            (None, identity(), identity(), identity())
        };
        let owner_password = &dict.o[..dict.o.len().min(32)];
        let user_password = &dict.u[..dict.u.len().min(32)];
        let flags = dict.p as i32;
        let revision = dict.r.unwrap_or(0);
        let encrypt_metadata = (algorithm == 4 || algorithm == 5) && dict.encrypt_metadata != Some(false);

        let key_params =
            KeyParams { file_id, owner_password, user_password, flags, revision, key_length, encrypt_metadata };
        let mut password_bytes: Option<Vec<u8>> = None;
        let mut raw_password_bytes: Option<Vec<u8>> = None;
        if let Some(password) = password {
            if revision == 6 {
                let prepped = sasl_prep(password);
                password_bytes = Some(prepped.clone().into_bytes());
                if prepped != password {
                    raw_password_bytes = Some(password.as_bytes().to_vec());
                }
            } else if algorithm == 5 {
                password_bytes = Some(password.as_bytes().to_vec());
            } else {
                password_bytes = Some(latin1_bytes(password));
            }
        }

        let mut encryption_key: Option<Vec<u8>> = if algorithm != 5 {
            prepare_key_data(&key_params, password_bytes.as_deref())
        } else {
            let fields = Revision5Fields {
                revision,
                owner_password,
                owner_validation_salt: slice(&dict.o, 32, 40),
                owner_key_salt: slice(&dict.o, 40, 48),
                u_bytes: slice(&dict.u, 0, 48),
                user_password,
                user_validation_salt: slice(&dict.u, 32, 40),
                user_key_salt: slice(&dict.u, 40, 48),
                owner_encryption: &dict.oe,
                user_encryption: &dict.ue,
            };
            let mut candidates = vec![password_bytes.as_deref()];
            if raw_password_bytes.is_some() {
                candidates.push(raw_password_bytes.as_deref());
            }
            candidates.into_iter().find_map(|candidate| create_encryption_key_20(&fields, candidate))
        };

        if encryption_key.is_none() {
            let Some(password_bytes) = password_bytes.as_deref() else {
                if algorithm >= 4 && stm_f.is_identity() && str_f.is_identity() {
                    let auth_event = cf
                        .as_deref()
                        .and_then(|cf| eff.name().and_then(|name| lookup(cf, name)))
                        .and_then(|f| f.auth_event.as_deref());
                    if auth_event == Some("EFOpen") {
                        return Ok(CipherTransformFactory {
                            dict: dict.clone(),
                            file_id: file_id.to_vec(),
                            algorithm,
                            encrypt_metadata,
                            stm_f,
                            str_f,
                            eff,
                            cf,
                            encryption_key: None,
                        });
                    }
                }
                return Err(SecurityError::need_password());
            };
            let decoded = decode_user_password(password_bytes, owner_password, revision, key_length);
            encryption_key = prepare_key_data(&key_params, Some(&decoded));
        }
        let Some(mut key) = encryption_key else {
            return Err(SecurityError::incorrect_password());
        };
        if algorithm == 4 && key.len() < 16 {
            key.resize(16, 0);
        }
        Ok(CipherTransformFactory {
            dict: dict.clone(),
            file_id: file_id.to_vec(),
            algorithm,
            encrypt_metadata,
            stm_f,
            str_f,
            eff,
            cf,
            encryption_key: Some(key),
        })
    }

    /// `setPassword`: opens the same document again with another password.
    pub fn set_password(&mut self, password: Option<&str>) -> Result<(), SecurityError> {
        let reopened = CipherTransformFactory::new(&self.dict, &self.file_id, password)?;
        self.encryption_key = reopened.encryption_key;
        Ok(())
    }

    /// Whether the document's metadata stream is encrypted (revision 4 and 5 can leave it clear).
    pub fn encrypt_metadata(&self) -> bool {
        self.encrypt_metadata
    }

    /// `createCipherTransform(num, gen)`.
    pub fn create_cipher_transform(&self, num: u32, generation: u32) -> CipherTransform {
        CipherTransform {
            algorithm: self.algorithm,
            encryption_key: self.encryption_key.clone(),
            cf: self.cf.clone(),
            num,
            generation,
            stm_f: self.stm_f.clone(),
            str_f: self.str_f.clone(),
            eff: self.eff.clone(),
            constructors: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

fn slice(bytes: &[u8], start: usize, end: usize) -> &[u8] {
    let end = end.min(bytes.len());
    &bytes[start.min(end)..end]
}

/// The values of an `Encrypt` dictionary of revision 5 or 6 that the password checks read.
struct Revision5Fields<'a> {
    revision: i64,
    owner_password: &'a [u8],
    owner_validation_salt: &'a [u8],
    owner_key_salt: &'a [u8],
    u_bytes: &'a [u8],
    user_password: &'a [u8],
    user_validation_salt: &'a [u8],
    user_key_salt: &'a [u8],
    owner_encryption: &'a [u8],
    user_encryption: &'a [u8],
}

fn create_encryption_key_20(fields: &Revision5Fields<'_>, password: Option<&[u8]>) -> Option<Vec<u8>> {
    let password = password.map_or(&[][..], |p| &p[..p.len().min(127)]);
    let algorithm = if fields.revision == 6 { Pdf2::Pdf20 } else { Pdf2::Pdf17 };
    if algorithm.check_user_password(password, fields.user_validation_salt, fields.user_password) {
        Some(algorithm.user_key(password, fields.user_key_salt, fields.user_encryption))
    } else if !password.is_empty()
        && algorithm.check_owner_password(password, fields.owner_validation_salt, fields.u_bytes, fields.owner_password)
    {
        Some(algorithm.owner_key(password, fields.owner_key_salt, fields.u_bytes, fields.owner_encryption))
    } else {
        None
    }
}

/// What the revision 2 to 4 key derivation reads besides the password.
struct KeyParams<'a> {
    file_id: &'a [u8],
    owner_password: &'a [u8],
    user_password: &'a [u8],
    flags: i32,
    revision: i64,
    key_length: i64,
    encrypt_metadata: bool,
}

fn prepare_key_data(params: &KeyParams<'_>, password: Option<&[u8]>) -> Option<Vec<u8>> {
    let KeyParams { file_id, owner_password, user_password, flags, revision, key_length, encrypt_metadata } = *params;
    let mut hash_data = Vec::with_capacity(40 + owner_password.len() + file_id.len());
    if let Some(password) = password {
        hash_data.extend_from_slice(&password[..password.len().min(32)]);
    }
    let have = hash_data.len();
    hash_data.extend_from_slice(&DEFAULT_PASSWORD_BYTES[..32 - have]);
    hash_data.extend_from_slice(owner_password);
    hash_data.extend_from_slice(&flags.to_le_bytes());
    hash_data.extend_from_slice(file_id);
    if revision >= 4 && !encrypt_metadata {
        hash_data.extend_from_slice(&[0xff; 4]);
    }
    let mut hash = md5(&hash_data);
    let key_length_in_bytes = usize::try_from(key_length >> 3).unwrap_or(0);
    if revision >= 3 {
        for _ in 0..50 {
            // pdf.js hashes `keyLengthInBytes` bytes of the 16 byte digest: a longer key reads zeros past its end.
            let mut round = hash.clone();
            round.resize(key_length_in_bytes, 0);
            hash = md5(&round);
        }
    }
    let encryption_key = hash[..key_length_in_bytes.min(hash.len())].to_vec();
    let check_data = if revision >= 3 {
        let mut data = DEFAULT_PASSWORD_BYTES.to_vec();
        data.extend_from_slice(file_id);
        let mut check = Rc4::new(&encryption_key).apply(&md5(&data));
        for j in 1..=19u8 {
            let derived: Vec<u8> = encryption_key.iter().map(|&b| b ^ j).collect();
            check = Rc4::new(&derived).apply(&check);
        }
        check
    } else {
        Rc4::new(&encryption_key).apply(&DEFAULT_PASSWORD_BYTES)
    };
    let matches = check_data.iter().enumerate().all(|(k, &d)| user_password.get(k) == Some(&d));
    matches.then_some(encryption_key)
}

fn decode_user_password(password: &[u8], owner_password: &[u8], revision: i64, key_length: i64) -> Vec<u8> {
    let mut hash_data = password[..password.len().min(32)].to_vec();
    let have = hash_data.len();
    hash_data.extend_from_slice(&DEFAULT_PASSWORD_BYTES[..32 - have]);
    let mut hash = md5(&hash_data);
    let key_length_in_bytes = usize::try_from(key_length >> 3).unwrap_or(0);
    if revision >= 3 {
        for _ in 0..50 {
            hash = md5(&hash);
        }
        let mut user_password = owner_password.to_vec();
        for j in (0..=19u8).rev() {
            let derived: Vec<u8> = (0..key_length_in_bytes).map(|k| hash.get(k).copied().unwrap_or(0) ^ j).collect();
            user_password = Rc4::new(&derived).apply(&user_password);
        }
        user_password
    } else {
        Rc4::new(&hash[..key_length_in_bytes.min(hash.len())]).apply(owner_password)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The transform of one object

const DECRYPT_CHUNK: usize = 512;

/// Decrypts the strings and streams of one indirect object (`CipherTransform`).
#[derive(Clone)]
pub struct CipherTransform {
    algorithm: i64,
    encryption_key: Option<Vec<u8>>,
    cf: Option<Vec<(String, CryptFilter)>>,
    num: u32,
    generation: u32,
    stm_f: CryptFilterName,
    str_f: CryptFilterName,
    eff: CryptFilterName,
    constructors: Arc<Mutex<HashMap<String, CipherKind>>>,
}

impl fmt::Debug for CipherTransform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The key stays out of any log line.
        f.debug_struct("CipherTransform")
            .field("num", &self.num)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl CipherTransform {
    fn cache_key(&self, name: &CryptFilterName) -> String {
        if self.algorithm < 4 { "__default__".into() } else { name.name().unwrap_or("__default__").to_owned() }
    }
    /// Check before validating a selector: a Name("__default__") can populate
    /// the same constructor slot later used by a non-Name selector.
    pub fn has_cached_constructor(&self, string: bool, explicit: Option<&str>, embedded: bool) -> bool {
        let explicit = explicit.map(CryptFilterName::from);
        let selected = if string {
            &self.str_f
        } else {
            explicit.as_ref().unwrap_or(if embedded { &self.eff } else { &self.stm_f })
        };
        self.constructors.lock().unwrap().contains_key(&self.cache_key(selected))
    }
    fn constructor(&self, name: &CryptFilterName) -> Result<CipherKind, SecurityError> {
        let key = self.cache_key(name);
        if let Some(kind) = self.constructors.lock().unwrap().get(&key).cloned() {
            return Ok(kind);
        }
        let kind = self.resolve(name)?;
        self.constructors.lock().unwrap().insert(key, kind.clone());
        Ok(kind)
    }
    /// Selectors are exposed so the PDF parser can resolve indirect CF entries lazily.
    pub fn string_filter_name(&self) -> Result<Option<&str>, SecurityError> {
        self.selected_name(&self.str_f)
    }
    pub fn stream_filter_name(&self, embedded: bool) -> Result<Option<&str>, SecurityError> {
        self.selected_name(if embedded { &self.eff } else { &self.stm_f })
    }
    pub fn uses_crypt_filters(&self) -> bool {
        self.algorithm >= 4
    }
    fn selected_name<'a>(&self, name: &'a CryptFilterName) -> Result<Option<&'a str>, SecurityError> {
        if self.algorithm < 4 {
            return Ok(None);
        }
        name.name().map(Some).ok_or_else(|| SecurityError::Format("Invalid crypt filter name.".into()))
    }
    /// Install only the CF entry actually selected at this lazy access.
    pub fn with_crypt_filters(mut self, filters: Vec<(String, CryptFilter)>) -> Self {
        self.cf = Some(filters);
        self
    }

    fn resolve(&self, filter_name: &CryptFilterName) -> Result<CipherKind, SecurityError> {
        if self.algorithm < 4 {
            let key = self.encryption_key.as_deref().unwrap_or_default();
            return Ok(CipherKind::Rc4(build_object_key(self.num, self.generation, key, false)));
        }
        let filter_name =
            filter_name.name().ok_or_else(|| SecurityError::Format("Invalid crypt filter name.".into()))?;
        let Some(cf) = &self.cf else {
            return Err(SecurityError::Format("Invalid crypt filter dictionary.".into()));
        };
        let cfm = lookup(cf, filter_name).and_then(|f| f.cfm.as_ref());
        let cfm = match cfm {
            None | Some(CryptFilterMethod::None) => return Ok(CipherKind::Null),
            Some(cfm) => cfm,
        };
        let Some(key) = &self.encryption_key else {
            return Err(SecurityError::need_password());
        };
        if self.algorithm == 5 || *cfm == CryptFilterMethod::AesV3 {
            return Ok(CipherKind::Aes256(key.clone()));
        }
        match cfm {
            CryptFilterMethod::V2 => Ok(CipherKind::Rc4(build_object_key(self.num, self.generation, key, false))),
            CryptFilterMethod::AesV2 => Ok(CipherKind::Aes128(build_object_key(self.num, self.generation, key, true))),
            _ => Err(SecurityError::Format("Unknown crypto method".into())),
        }
    }

    /// Resolve the cipher at createStream time, without consuming encrypted bytes.
    pub fn validate_stream(&self, crypt_filter_name: Option<&str>, embedded_file: bool) -> Result<(), SecurityError> {
        let default = if self.algorithm >= 4 && embedded_file { &self.eff } else { &self.stm_f };
        let explicit = crypt_filter_name.map(CryptFilterName::from);
        self.constructor(explicit.as_ref().unwrap_or(default)).map(|_| ())
    }

    /// `decryptString`: the bytes of a string object, decrypted with the string crypt filter.
    pub fn decrypt_string(&self, data: &[u8]) -> Result<Vec<u8>, SecurityError> {
        let mut cipher = self.constructor(&self.str_f)?.instantiate();
        Ok(cipher.decrypt_block(data, true))
    }

    /// `createStream`: the bytes of a stream, decrypted in chunks of 512 bytes as `DecryptStream` does, with the
    /// crypt filter named by the stream (`Crypt` filter `Name`), else the embedded file filter when the stream is an
    /// `EmbeddedFile`, else the stream crypt filter. Output exceeding `limit` returns `ResourceLimit`.
    pub fn decrypt_stream(
        &self,
        data: &[u8],
        crypt_filter_name: Option<&str>,
        embedded_file: bool,
        limit: usize,
    ) -> Result<Vec<u8>, SecurityError> {
        let default_name = if self.algorithm >= 4 && embedded_file { &self.eff } else { &self.stm_f };
        let explicit = crypt_filter_name.map(CryptFilterName::from);
        let mut cipher = self.constructor(explicit.as_ref().unwrap_or(default_name))?.instantiate();
        let mut out = Vec::new();
        let mut chunks = data.chunks(DECRYPT_CHUNK).peekable();
        while let Some(chunk) = chunks.next() {
            out.extend_from_slice(&cipher.decrypt_block(chunk, chunks.peek().is_none()));
            if out.len() > limit {
                return Err(SecurityError::ResourceLimit { limit });
            }
        }
        Ok(out)
    }
}
