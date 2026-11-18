//! How an `\EncryptionInfo` stream encrypts its package ([MS-OFFCRYPTO] 2.3.4): agile encryption (2.3.4.10) with an XML
//! descriptor, or standard encryption (2.3.4.5) with a binary header. Anything outside those two schemes (extensible
//! encryption, a cipher or chaining mode the spec allows but Office does not write) is "unsupported", never a guess.
//!
//! The agile descriptor is XML, read with quick-xml's namespace-aware reader (namespace-aware, as the schema needs;
//! a text pattern would not be). No external entity is resolved and only the predefined ones are known; a DTD is
//! refused outright.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use quick_xml::NsReader;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::{Namespace, ResolveResult};

use crate::hashes::HashAlgorithm;

const ENCRYPTION_NAMESPACE: &str = "http://schemas.microsoft.com/office/2006/encryption";
const PASSWORD_KEY_ENCRYPTOR: &str = "http://schemas.microsoft.com/office/2006/keyEncryptor/password";
/// 2.3.4.10: spinCount MUST NOT exceed 10,000,000.
pub const MAX_SPIN_COUNT: u64 = 10_000_000;
const STANDARD_FLAG_CRYPTOAPI: u32 = 0x04;
const STANDARD_FLAG_AES: u32 = 0x20;

/// One cipher description (keyData, or the password encryptedKey): AES-CBC with a hash this build computes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgileCipher {
    pub key_bits: usize,
    pub block_size: usize,
    pub salt_size: usize,
    pub hash_size: usize,
    pub algorithm: HashAlgorithm,
    pub salt: Vec<u8>,
}

/// 2.3.4.14: the encrypted salt (the HMAC key) and the encrypted HMAC, each padded with 0x00 to whole blocks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Integrity {
    /// A dataIntegrity element that cannot be checked: the package is then never rendered.
    Malformed,
    Present {
        hmac_key: Vec<u8>,
        hmac_value: Vec<u8>,
        salt_length: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgileDescriptor {
    pub data: AgileCipher,
    pub key: AgileCipher,
    pub spin_count: u32,
    pub verifier_input: Vec<u8>,
    pub verifier_hash: Vec<u8>,
    pub encrypted_key: Vec<u8>,
    /// `None` without a dataIntegrity element.
    pub integrity: Option<Integrity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StandardDescriptor {
    pub key_bits: usize,
    pub salt: Vec<u8>,
    pub verifier: Vec<u8>,
    pub verifier_hash: Vec<u8>,
    pub verifier_hash_size: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Descriptor {
    Agile(AgileDescriptor),
    Standard(StandardDescriptor),
}

// [W3C-XSD] lexical forms of the attribute types the descriptor uses.

fn is_xml_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | ' ')
}

/// `String.prototype.trim`: the ECMAScript WhiteSpace and LineTerminator code points.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Whitespace runs collapsed to one space, then trimmed (xs:token).
fn collapse(value: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in value.chars() {
        if is_xml_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out.trim_matches(is_js_space).to_owned()
}

/// xs:unsignedInt (whitespace collapsed): decimal digits with an optional "+", at most 4,294,967,295. An absent
/// attribute is `None`.
fn unsigned_int(value: Option<&str>) -> Option<u64> {
    let text = collapse(value?);
    let digits = text.strip_prefix('+').unwrap_or(&text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number: u64 = digits.parse().ok()?;
    (number <= 0xffff_ffff).then_some(number)
}

/// xs:base64Binary: whole quads of the base64 alphabet (whitespace between them allowed), the last one padded with
/// "=" over the unused bits, which must be zero. An absent attribute reads as the empty text, which is valid.
fn base64_binary(value: Option<&str>) -> Option<Vec<u8>> {
    let text: String = value.unwrap_or("").chars().filter(|c| !is_xml_space(*c)).collect();
    let bytes = text.as_bytes();
    let alphabet = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/';
    if bytes.len() % 4 != 0 {
        return None;
    }
    // A closing quad of "xy==" or "xyz=" whose last character leaves the unused bits zero, after whole quads.
    let body = match bytes {
        [rest @ .., a, b, b'=', b'='] if alphabet(a) && b"AQgw".contains(b) => rest,
        [rest @ .., a, b, c, b'='] if alphabet(a) && alphabet(b) && b"AEIMQUYcgkosw048".contains(c) => rest,
        _ => bytes,
    };
    if !body.iter().all(alphabet) {
        return None;
    }
    STANDARD.decode(&text).ok()
}

/// The unqualified attributes of an element (the descriptor's schemas set attributeFormDefault="unqualified").
type Attributes = HashMap<String, String>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Uri {
    Encryption,
    PasswordKeyEncryptor,
    Other,
    None,
}

fn classify(result: &ResolveResult<'_>) -> Result<Uri, String> {
    match result {
        ResolveResult::Unbound => Ok(Uri::None),
        ResolveResult::Bound(Namespace(namespace)) => Ok(if *namespace == ENCRYPTION_NAMESPACE.as_bytes() {
            Uri::Encryption
        } else if *namespace == PASSWORD_KEY_ENCRYPTOR.as_bytes() {
            Uri::PasswordKeyEncryptor
        } else {
            Uri::Other
        }),
        ResolveResult::Unknown(_) => Err("unbound namespace prefix".to_owned()),
    }
}

fn unqualified(reader: &NsReader<&[u8]>, tag: &BytesStart<'_>) -> Result<Attributes, String> {
    let mut values = Attributes::new();
    for attribute in tag.attributes() {
        let attribute = attribute.map_err(|error| error.to_string())?;
        let key = attribute.key.as_ref();
        if key == b"xmlns" || key.starts_with(b"xmlns:") {
            continue;
        }
        let (resolved, local) = reader.resolve_attribute(attribute.key);
        match resolved {
            ResolveResult::Unbound => {}
            ResolveResult::Bound(_) => continue,
            ResolveResult::Unknown(_) => return Err("unbound attribute prefix".to_owned()),
        }
        let raw = std::str::from_utf8(&attribute.value).map_err(|error| error.to_string())?;
        if raw.contains('<') {
            return Err("'<' in an attribute value".to_owned());
        }
        // Attribute-value normalization: a literal tab, line feed or carriage return (a CRLF pair counting once) is
        // one space; a character reference to one stays what it names.
        let normalized = raw.replace("\r\n", " ").replace(['\t', '\n', '\r'], " ");
        let value = quick_xml::escape::unescape(&normalized).map_err(|error| error.to_string())?;
        values.insert(String::from_utf8_lossy(local.as_ref()).into_owned(), value.into_owned());
    }
    Ok(values)
}

/// CT_Encryption is this sequence: keyData, an optional dataIntegrity, keyEncryptors.
const ENCRYPTION_SEQUENCE: [&str; 3] = ["keyData", "dataIntegrity", "keyEncryptors"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Encryption,
    KeyData,
    DataIntegrity,
    KeyEncryptors,
    KeyEncryptor,
    PasswordKeyEncryptor,
    EncryptedKey,
    Other,
}

struct Open {
    kind: Kind,
    children: u32,
}

#[derive(Default)]
struct Fields {
    key_data: Option<Attributes>,
    data_integrity: Option<Attributes>,
    encrypted_key: Option<Attributes>,
}

struct Walk {
    fields: Fields,
    open: Vec<Open>,
    position: i32,
    key_encryptors: u32,
    password_key_encryptors: u32,
    root_seen: bool,
}

impl Walk {
    fn open_tag(&mut self, reader: &NsReader<&[u8]>, tag: &BytesStart<'_>, uri: Uri) -> Result<(), String> {
        let local = String::from_utf8_lossy(tag.local_name().as_ref()).into_owned();
        let encryption = uri == Uri::Encryption;
        let attributes = unqualified(reader, tag)?;
        let kind;
        match self.open.last().map(|parent| parent.kind) {
            None => {
                if self.root_seen {
                    return Err("only one root element is allowed".to_owned());
                }
                if !encryption || local != "encryption" {
                    return Err("not an encryption descriptor".to_owned());
                }
                self.root_seen = true;
                kind = Kind::Encryption;
            }
            Some(Kind::Encryption) => {
                let at = ENCRYPTION_SEQUENCE
                    .iter()
                    .position(|name| *name == local)
                    .map(|at| at as i32);
                match at {
                    Some(at) if encryption && at > self.position => {
                        self.position = at;
                        kind = match at {
                            0 => Kind::KeyData,
                            1 => Kind::DataIntegrity,
                            _ => Kind::KeyEncryptors,
                        };
                        match kind {
                            Kind::KeyData => self.fields.key_data = Some(attributes),
                            Kind::DataIntegrity => self.fields.data_integrity = Some(attributes),
                            _ => {}
                        }
                    }
                    _ => return Err("unexpected element in encryption".to_owned()),
                }
            }
            Some(Kind::KeyEncryptors) => {
                if !encryption || local != "keyEncryptor" {
                    return Err("unexpected element in keyEncryptors".to_owned());
                }
                self.key_encryptors += 1;
                let password =
                    attributes.get("uri").map(|uri| collapse(uri)).as_deref() == Some(PASSWORD_KEY_ENCRYPTOR);
                if password {
                    self.password_key_encryptors += 1;
                }
                kind = if password {
                    Kind::PasswordKeyEncryptor
                } else {
                    Kind::KeyEncryptor
                };
            }
            Some(parent @ (Kind::PasswordKeyEncryptor | Kind::KeyEncryptor)) => {
                let holder = self.open.last_mut().ok_or_else(|| "no parent".to_owned())?;
                holder.children += 1;
                if holder.children > 1 {
                    return Err("a keyEncryptor holds one element".to_owned());
                }
                if parent == Kind::PasswordKeyEncryptor {
                    if uri != Uri::PasswordKeyEncryptor || local != "encryptedKey" {
                        return Err("not a password key".to_owned());
                    }
                    self.fields.encrypted_key = Some(attributes);
                    kind = Kind::EncryptedKey;
                } else {
                    kind = Kind::Other;
                }
            }
            Some(Kind::Other) => kind = Kind::Other,
            // keyData, dataIntegrity and encryptedKey are attributes only.
            Some(_) => return Err("an attribute-only element has child elements".to_owned()),
        }
        self.open.push(Open { kind, children: 0 });
        Ok(())
    }

    fn close_tag(&mut self) -> Result<(), String> {
        let closed = self.open.pop().ok_or_else(|| "unexpected closing tag".to_owned())?;
        if matches!(closed.kind, Kind::KeyEncryptor | Kind::PasswordKeyEncryptor) && closed.children != 1 {
            return Err("a keyEncryptor holds one element".to_owned());
        }
        Ok(())
    }
}

/// The attributes of keyData, dataIntegrity (`None` when absent) and the password encryptedKey of an
/// XmlEncryptionDescriptor (2.3.4.10), read by namespace: the root is encryption, its children follow the CT_Encryption
/// sequence, keyEncryptors holds at least one keyEncryptor of exactly one element each, and exactly one of them is the
/// password key encryptor (uri "…/keyEncryptor/password") holding the encryptedKey of that namespace. An error for a
/// DTD, malformed XML, an encoding other than UTF-8, or any other structure where these fields live.
fn descriptor_fields(xml: &str) -> Result<Fields, String> {
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut walk = Walk {
        fields: Fields::default(),
        open: Vec::new(),
        position: -1,
        key_encryptors: 0,
        password_key_encryptors: 0,
        root_seen: false,
    };
    let mut first = true;
    loop {
        let (resolved, event) = reader.read_resolved_event().map_err(|error| error.to_string())?;
        let uri = classify(&resolved);
        drop(resolved);
        match event {
            Event::Decl(declaration) => {
                if !first {
                    return Err("an XML declaration is only allowed at the start".to_owned());
                }
                declaration.version().map_err(|error| error.to_string())?;
                match declaration.encoding() {
                    Some(Ok(encoding)) if !encoding.as_ref().eq_ignore_ascii_case(b"utf-8") => {
                        return Err("descriptor is not UTF-8".to_owned());
                    }
                    Some(Err(error)) => return Err(error.to_string()),
                    _ => {}
                }
            }
            Event::DocType(_) => return Err("a DTD is not allowed in the descriptor".to_owned()),
            Event::Start(tag) => walk.open_tag(&reader, &tag, uri?)?,
            Event::Empty(tag) => {
                walk.open_tag(&reader, &tag, uri?)?;
                walk.close_tag()?;
            }
            Event::End(_) => walk.close_tag()?,
            Event::Text(text) => {
                let decoded = text.decode().map_err(|error| error.to_string())?;
                if walk.open.is_empty() && !decoded.chars().all(is_xml_space) {
                    return Err("text outside the root element".to_owned());
                }
            }
            Event::CData(_) => {
                if walk.open.is_empty() {
                    return Err("text outside the root element".to_owned());
                }
            }
            Event::GeneralRef(reference) => {
                if walk.open.is_empty() {
                    return Err("text outside the root element".to_owned());
                }
                let name = reference.decode().map_err(|error| error.to_string())?;
                quick_xml::escape::unescape(&format!("&{name};")).map_err(|error| error.to_string())?;
            }
            Event::PI(instruction) => {
                if instruction.target().eq_ignore_ascii_case(b"xml") {
                    return Err("an XML declaration is only allowed at the start".to_owned());
                }
            }
            Event::Comment(_) => {}
            Event::Eof => break,
        }
        first = false;
    }
    if !walk.open.is_empty() || !walk.root_seen {
        return Err("the document is not complete".to_owned());
    }
    if walk.fields.key_data.is_none()
        || walk.position != 2
        || walk.key_encryptors < 1
        || walk.password_key_encryptors != 1
    {
        return Err("incomplete encryption descriptor".to_owned());
    }
    Ok(walk.fields)
}

/// One cipher description (keyData, or the password encryptedKey), or `None` when it is not AES-CBC with a hash this
/// build computes, or its values do not match their schema types.
fn agile_cipher(values: &Attributes) -> Option<AgileCipher> {
    let get = |name: &str| values.get(name).map(String::as_str);
    let key_bits = unsigned_int(get("keyBits"));
    let block_size = unsigned_int(get("blockSize"));
    let salt_size = unsigned_int(get("saltSize"));
    let hash_size = unsigned_int(get("hashSize"));
    let algorithm = get("hashAlgorithm").and_then(HashAlgorithm::from_descriptor_name);
    let salt = base64_binary(get("saltValue"));
    if get("cipherAlgorithm") != Some("AES") || get("cipherChaining") != Some("ChainingModeCBC") {
        return None;
    }
    let key_bits = key_bits.filter(|bits| [128, 192, 256].contains(bits))?;
    if block_size != Some(16) {
        return None;
    }
    let algorithm = algorithm?;
    let (hash_size, salt_size) = (hash_size?, salt_size?);
    let salt = salt?;
    if algorithm.digest_length().map(|length| length as u64) != Some(hash_size)
        || salt_size < 1
        || salt.len() as u64 != salt_size
    {
        return None;
    }
    Some(AgileCipher {
        key_bits: key_bits as usize,
        block_size: 16,
        salt_size: salt_size as usize,
        hash_size: hash_size as usize,
        algorithm,
        salt,
    })
}

/// base64Binary ciphertext of whole cipher blocks holding at least `least` bytes, or `None`.
fn ciphertext(value: Option<&str>, block_size: usize, least: usize) -> Option<Vec<u8>> {
    base64_binary(value).filter(|bytes| bytes.len() >= least && bytes.len() % block_size == 0)
}

fn whole_blocks(length: usize, block_size: usize) -> usize {
    length.div_ceil(block_size) * block_size
}

/// 2.3.4.14: the encrypted salt (the HMAC key) and the encrypted HMAC (hashSize bytes), each padded with 0x00 to whole
/// blocks. Step 2 makes the salt KeyData.saltSize bytes long. Excel writes hashSize bytes instead (a file it saves holds
/// saltSize 16, hashSize 64 and a 64-byte encryptedHmacKey whose bytes past the 16th are not padding), as Apache POI and
/// msoffcrypto-tool do. The padded length says which of the two a file holds; where both pad to the same size the longer
/// is taken, because the shorter one's further bytes are its 0x00 padding and [RFC2104] keys the HMAC identically with
/// them (that size is at most 64 bytes, within one hash block). A present element that is anything else is malformed:
/// the package is then never rendered.
fn data_integrity(values: Option<&Attributes>, data: &AgileCipher) -> Option<Integrity> {
    let values = values?;
    let get = |name: &str| values.get(name).map(String::as_str);
    let hmac_key = base64_binary(get("encryptedHmacKey"));
    let hmac_value = base64_binary(get("encryptedHmacValue"));
    let salt_length = [data.salt_size, data.hash_size]
        .into_iter()
        .filter(|length| hmac_key.as_ref().map(Vec::len) == Some(whole_blocks(*length, data.block_size)))
        .max();
    match (salt_length, hmac_key, hmac_value) {
        (Some(salt_length), Some(hmac_key), Some(hmac_value))
            if hmac_value.len() == whole_blocks(data.hash_size, data.block_size) =>
        {
            Some(Integrity::Present {
                hmac_key,
                hmac_value,
                salt_length,
            })
        }
        _ => Some(Integrity::Malformed),
    }
}

fn agile_descriptor(info: &[u8]) -> Option<AgileDescriptor> {
    let mut body = &info[8..];
    // TextDecoder drops a leading byte order mark.
    if let Some(rest) = body.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        body = rest;
    }
    let fields = descriptor_fields(std::str::from_utf8(body).ok()?).ok()?;
    let values = fields.encrypted_key.as_ref()?;
    let data = agile_cipher(fields.key_data.as_ref()?)?;
    let key = agile_cipher(values)?;
    let spin_count = unsigned_int(values.get("spinCount").map(String::as_str))?;
    if spin_count > MAX_SPIN_COUNT {
        return None;
    }
    // The password key encryptor MUST use the keyData's cipher (both AES here) and hash algorithm.
    if key.algorithm != data.algorithm {
        return None;
    }
    // 2.3.4.13: the verifier input (saltSize bytes), its hash and the intermediate key, each padded to whole blocks.
    let get = |name: &str| values.get(name).map(String::as_str);
    let verifier_input = ciphertext(get("encryptedVerifierHashInput"), key.block_size, key.salt_size)?;
    let verifier_hash = ciphertext(get("encryptedVerifierHashValue"), key.block_size, key.hash_size)?;
    let encrypted_key = ciphertext(get("encryptedKeyValue"), key.block_size, data.key_bits / 8)?;
    let integrity = data_integrity(fields.data_integrity.as_ref(), &data);
    Some(AgileDescriptor {
        data,
        key,
        spin_count: spin_count as u32,
        verifier_input,
        verifier_hash,
        encrypted_key,
        integrity,
    })
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn standard_descriptor(info: &[u8]) -> Option<StandardDescriptor> {
    if info.len() < 12 {
        return None;
    }
    let header_size = u64::from(u32_at(info, 8));
    if header_size < 32 || 12 + header_size + 4 > info.len() as u64 {
        return None;
    }
    // 2.3.2 EncryptionHeader.Flags: standard encryption sets fCryptoAPI and fAES.
    let flags = u32_at(info, 12);
    let key_bits = match u32_at(info, 20) {
        0x660e => 128,
        0x660f => 192,
        0x6610 => 256,
        _ => return None,
    };
    let hash_algorithm = u32_at(info, 24);
    if flags & STANDARD_FLAG_CRYPTOAPI == 0 || flags & STANDARD_FLAG_AES == 0 {
        return None;
    }
    if u32_at(info, 28) as usize != key_bits || ![0, 0x8004].contains(&hash_algorithm) {
        return None;
    }
    // 2.3.3 EncryptionVerifier: SaltSize (16), Salt, EncryptedVerifier (16), VerifierHashSize (20), and the AES-padded
    // EncryptedVerifierHash (32).
    let at = (12 + header_size) as usize;
    if u32_at(info, at) != 16 || (at + 4 + 16 + 16 + 4 + 32) > info.len() {
        return None;
    }
    let verifier_hash_size = u32_at(info, at + 36) as usize;
    if verifier_hash_size != 20 {
        return None;
    }
    Some(StandardDescriptor {
        key_bits,
        salt: info[at + 4..at + 20].to_vec(),
        verifier: info[at + 20..at + 36].to_vec(),
        verifier_hash: info[at + 40..at + 72].to_vec(),
        verifier_hash_size,
    })
}

/// How an `\EncryptionInfo` stream encrypts its package, or `None` when this is not agile or standard encryption with
/// parameters Office writes. The version decides (2.3.4.5, 2.3.4.10): 4.4 with reserved 0x40 is agile, minor 2 with
/// major 2, 3 or 4 is standard; minor 3 (extensible) is unsupported. An agile descriptor's `integrity` is `None`
/// without a dataIntegrity element and `Malformed` for one that cannot be checked.
#[must_use]
pub fn ooxml_encryption(info: &[u8]) -> Option<Descriptor> {
    if info.len() < 8 {
        return None;
    }
    let major = u16::from_le_bytes([info[0], info[1]]);
    let minor = u16::from_le_bytes([info[2], info[3]]);
    if major == 4 && minor == 4 {
        return if u32_at(info, 4) == 0x40 {
            agile_descriptor(info).map(Descriptor::Agile)
        } else {
            None
        };
    }
    if [2, 3, 4].contains(&major) && minor == 2 {
        return standard_descriptor(info).map(Descriptor::Standard);
    }
    None
}
