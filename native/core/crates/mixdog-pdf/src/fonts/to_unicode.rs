//! How a font's character codes become text, ported from pdf.js 6.4.299 (`ToUnicodeMap`, `IdentityToUnicodeMap` of
//! `src/core/to_unicode_map.js`; `PartialEvaluator.extractDataStructures`, `readToUnicode`, `buildToUnicode`,
//! `_simpleFontToUnicode` and `readCidToGidMap` of `src/core/evaluator.js`).
//!
//! The resolution order is pdf.js's: the `/ToUnicode` stream or predefined name; for a simple font the base encoding
//! with `/Differences` through the glyph names (the glyph list, `uniXXXX` and `uXXXX` names, `gNN`, `cNN`, `GNN` and
//! `CNN` names as pdf.js reads them); for a CID font on a predefined CMap or one of the Adobe CJK orderings the
//! `<registry>-<ordering>-UCS2` CMap; otherwise the identity.
//!
//! Strings are JavaScript strings, that is UTF-16 code units, because a ToUnicode entry may hold a lone surrogate.

use std::collections::{BTreeMap, HashMap};

use super::data::{
    self,
    encodings::{
        MAC_ROMAN_ENCODING, STANDARD_ENCODING, SYMBOL_SET_ENCODING, WIN_ANSI_ENCODING,
        ZAPF_DINGBATS_ENCODING, get_encoding,
    },
    font_flags,
    glyphlist::GLYPHS_UNICODE,
    standard_fonts::SYMBOLS_FONTS,
};
use super::font::{CidSystemInfo, Properties};
use super::widths::is_integer;
use crate::error::{PdfError, Result};
use crate::fontfile::cmap::{CMap, CMapEncoding, CMapFactory, CMapValue};
use crate::object::{Dict, Obj};
use crate::xref::Xref;

/// The most code points a simple font's encoding may name: pdf.js's arrays are sparse, so a `/Differences` index that
/// is huge costs it nothing; here such an entry is ignored (no font has a code that is not 16 bits wide).
const MAX_ENCODING_CODE: i64 = 0xffff;

/// The chinese font names (GBK bytes read as Latin-1) that pdf.js reads through the GBK CMap.
const CHINESE_FONT_NAMES: [&str; 10] = [
    "\u{cb}\u{ce}\u{cc}\u{e5}",
    "\u{ba}\u{da}\u{cc}\u{e5}",
    "\u{bf}\u{ac}\u{cc}\u{e5}",
    "\u{b7}\u{c2}\u{cb}\u{ce}",
    "\u{bf}\u{ac}\u{cc}\u{e5}_GB2312",
    "\u{b7}\u{c2}\u{cb}\u{ce}_GB2312",
    "\u{c1}\u{a5}\u{ca}\u{e9}",
    "\u{d0}\u{c2}\u{cb}\u{ce}",
    "\u{b7}\u{c2}\u{cb}\u{ce}\u{cc}\u{e5}",
    "\u{d0}\u{a1}\u{b1}\u{ea}\u{cb}\u{ce}",
];

/// What a ToUnicode map holds for a code: a number (a code point, a character code or a CID, as the map was built) or
/// a JavaScript string.
#[derive(Debug, Clone, PartialEq)]
pub enum UniValue {
    Code(i64),
    Str(Vec<u16>),
}

/// `String.fromCharCode(code)`.
pub(crate) fn from_char_code(code: i64) -> Vec<u16> {
    vec![(code & 0xffff) as u16]
}

/// `String.fromCodePoint(...codes)`: a `RangeError` for a value that is not a code point. A lone surrogate is kept.
pub(crate) fn from_code_points(codes: &[i64]) -> Result<Vec<u16>> {
    let mut out = Vec::with_capacity(codes.len());
    for &code in codes {
        if !(0..=0x10_ffff).contains(&code) {
            return Err(PdfError::Unknown(format!("Invalid code point {code}")));
        }
        if code < 0x1_0000 {
            out.push(code as u16);
        } else {
            let value = code - 0x1_0000;
            out.push(0xd800 + (value >> 10) as u16);
            out.push(0xdc00 + (value & 0x3ff) as u16);
        }
    }
    Ok(out)
}

/// `str.codePointAt(0)`: `None` for the empty string.
fn code_point_at_start(units: &[u16]) -> Option<u32> {
    let first = *units.first()?;
    if (0xd800..0xdc00).contains(&first)
        && let Some(&second) = units.get(1)
        && (0xdc00..0xe000).contains(&second)
    {
        return Some(0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00));
    }
    Some(u32::from(first))
}

/// `ToUnicodeMap`: character code to string, in the order the entries were added.
#[derive(Debug, Clone, Default)]
pub struct ToUnicodeMap {
    entries: Vec<(u32, UniValue)>,
    index: HashMap<u32, usize>,
}

impl ToUnicodeMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Map.set`: a repeated code changes its value and keeps its place.
    pub fn set(&mut self, code: u32, value: UniValue) {
        match self.index.get(&code) {
            Some(&at) => self.entries[at].1 = value,
            None => {
                self.index.insert(code, self.entries.len());
                self.entries.push((code, value));
            }
        }
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }

    pub fn has(&self, code: u32) -> bool {
        self.index.contains_key(&code)
    }

    pub fn get(&self, code: u32) -> Option<&UniValue> {
        self.index.get(&code).map(|&at| &self.entries[at].1)
    }

    /// `charCodeOf(value)`: the first code whose entry is `value`, or -1.
    pub fn char_code_of(&self, value: &UniValue) -> i64 {
        self.entries
            .iter()
            .find(|(_, entry)| entry == value)
            .map_or(-1, |(code, _)| i64::from(*code))
    }

    /// `amend(map)`: the entries of `other` are set, over those that are there.
    pub fn amend(&mut self, other: &ToUnicodeMap) {
        for (code, value) in &other.entries {
            self.set(*code, value.clone());
        }
    }

    /// `forEach(callback)`: the callback is given the first code point of each entry (`None` for an empty string). An
    /// entry that is a number has no `codePointAt`: the `TypeError` of pdf.js.
    pub fn for_each(&self, mut callback: impl FnMut(u32, Option<u32>)) -> Result<()> {
        for (code, entry) in &self.entries {
            match entry {
                UniValue::Str(units) => callback(*code, code_point_at_start(units)),
                UniValue::Code(_) => {
                    return Err(PdfError::Unknown(
                        "entry.codePointAt is not a function".to_owned(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn iter(&self) -> impl Iterator<Item = (u32, &UniValue)> {
        self.entries.iter().map(|(code, value)| (*code, value))
    }

    /// `Map.delete(code)`.
    pub fn delete(&mut self, code: u32) {
        let Some(at) = self.index.remove(&code) else {
            return;
        };
        self.entries.remove(at);
        for slot in self.index.values_mut() {
            if *slot > at {
                *slot -= 1;
            }
        }
    }
}

/// `IdentityToUnicodeMap`: every code from `first_char` to `last_char` is its own character.
#[derive(Debug, Clone, Copy)]
pub struct IdentityToUnicodeMap {
    pub first_char: i64,
    pub last_char: i64,
}

impl IdentityToUnicodeMap {
    pub fn size(&self) -> i64 {
        self.last_char + 1 - self.first_char
    }

    pub fn has(&self, code: i64) -> bool {
        self.first_char <= code && code <= self.last_char
    }
}

/// A font's ToUnicode map: read from the file, built from the encoding, or the identity.
#[derive(Debug, Clone)]
pub enum ToUnicode {
    Map(ToUnicodeMap),
    Identity(IdentityToUnicodeMap),
}

impl ToUnicode {
    /// `size`: a map with a size of 0 is as good as none.
    pub fn size(&self) -> i64 {
        match self {
            ToUnicode::Map(map) => map.size() as i64,
            ToUnicode::Identity(identity) => identity.size(),
        }
    }

    pub fn has(&self, code: u32) -> bool {
        match self {
            ToUnicode::Map(map) => map.has(code),
            ToUnicode::Identity(identity) => identity.has(i64::from(code)),
        }
    }

    pub fn get(&self, code: u32) -> Option<UniValue> {
        match self {
            ToUnicode::Map(map) => map.get(code).cloned(),
            ToUnicode::Identity(identity) => identity
                .has(i64::from(code))
                .then(|| UniValue::Str(from_char_code(i64::from(code)))),
        }
    }

    /// `charCodeOf(value)`.
    pub fn char_code_of(&self, value: &UniValue) -> i64 {
        match self {
            ToUnicode::Map(map) => map.char_code_of(value),
            ToUnicode::Identity(identity) => match value {
                UniValue::Code(code)
                    if identity.first_char <= *code && *code <= identity.last_char =>
                {
                    *code
                }
                _ => -1,
            },
        }
    }

    pub fn is_identity(&self) -> bool {
        matches!(self, ToUnicode::Identity(_))
    }

    /// `forEach(callback)`: each code with the first code point of its text (`None` for an empty text).
    pub fn for_each(&self, mut callback: impl FnMut(u32, Option<u32>)) -> Result<()> {
        match self {
            ToUnicode::Map(map) => map.for_each(callback),
            ToUnicode::Identity(identity) => {
                for code in identity.first_char..=identity.last_char {
                    if let Ok(code) = u32::try_from(code) {
                        callback(code, Some(code));
                    }
                }
                Ok(())
            }
        }
    }

    /// `amend(map)`: callers do not amend the identity map (pdf.js throws there; each caller tests for it first).
    pub fn amend(&mut self, other: &ToUnicodeMap) {
        if let ToUnicode::Map(map) = self {
            map.amend(other);
        }
    }
}

// ---- JavaScript number parsing -------------------------------------------------------------------------------------

/// `parseInt(text, 16)`: white space, a sign and `0x` may lead, then the longest run of hex digits; `None` is `NaN`.
fn parse_int_hex(text: &str) -> Option<i64> {
    let text = text.trim_start_matches(data::is_js_whitespace);
    let (negative, text) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let text = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .unwrap_or(text);
    let digits = text.bytes().take_while(u8::is_ascii_hexdigit).count();
    if digits == 0 {
        return None;
    }
    let value = text[..digits].bytes().fold(0_i64, |sum, byte| {
        sum.saturating_mul(16)
            .saturating_add(i64::from((byte as char).to_digit(16).unwrap_or(0)))
    });
    Some(if negative { -value } else { value })
}

/// `+text` (the `Number` conversion of a short glyph-name suffix): white space is trimmed, the empty string is 0, `0x`,
/// `0o` and `0b` prefixes are read, and a decimal number may have a sign, a fraction and an exponent. `None` is `NaN`.
fn js_number(text: &str) -> Option<f64> {
    let text = text.trim_matches(data::is_js_whitespace);
    if text.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return i64::from_str_radix(digits, radix)
                .ok()
                .filter(|_| !digits.starts_with(['+', '-']))
                .map(|value| value as f64);
        }
    }
    if !text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    text.parse::<f64>().ok()
}

// ---- reading the ToUnicode entry -----------------------------------------------------------------------------------

/// The map of a `/ToUnicode` that is a CMap: its entries as strings.
fn to_unicode_from_cmap(cmap: &CMap) -> Result<ToUnicode> {
    if cmap.is_identity_kind() {
        return Ok(ToUnicode::Identity(IdentityToUnicodeMap {
            first_char: 0,
            last_char: 0xffff,
        }));
    }
    let mut map = ToUnicodeMap::new();
    for (code, token) in cmap.get_map() {
        match token {
            CMapValue::Cid(value) => map.set(code, UniValue::Str(from_code_points(&[value])?)),
            CMapValue::Str(mut units) => {
                if units.len() % 2 != 0 {
                    units.insert(0, 0);
                }
                let mut points = Vec::new();
                let mut k = 0;
                while k < units.len() {
                    let w1 = i64::from(units[k]) << 8 | i64::from(units[k + 1]);
                    if (w1 & 0xf800) != 0xd800 {
                        points.push(w1);
                        k += 2;
                        continue;
                    }
                    k += 2;
                    let unit = |at: usize| units.get(at).map_or(0, |unit| i64::from(*unit));
                    let w2 = unit(k) << 8 | unit(k + 1);
                    points.push(((w1 & 0x3ff) << 10) + (w2 & 0x3ff) + 0x1_0000);
                    k += 2;
                }
                map.set(code, UniValue::Str(from_code_points(&points)?));
            }
            // pdf.js would build the string "\0[object Object]" here; a `bfrange` array holds no such entry.
            CMapValue::Other => {}
        }
    }
    Ok(ToUnicode::Map(map))
}

/// `readToUnicode(cmapObj)`: a predefined name or an embedded CMap. A name that is not one is an error; an embedded
/// CMap that cannot be read is warned about and ignored (`ignoreErrors`).
pub fn read_to_unicode(xref: &Xref, cmap_obj: &Obj) -> Result<Option<ToUnicode>> {
    match cmap_obj {
        Obj::Name(name) => {
            let cmap = CMapFactory::create(Some(CMapEncoding::Name(name)), None, xref.guard())?;
            if cmap.is_identity_kind() {
                return Ok(Some(ToUnicode::Identity(IdentityToUnicodeMap {
                    first_char: 0,
                    last_char: 0xffff,
                })));
            }
            let mut map = ToUnicodeMap::new();
            for (code, value) in cmap.get_map() {
                map.set(
                    code,
                    match value {
                        CMapValue::Cid(cid) => UniValue::Code(cid),
                        CMapValue::Str(units) => UniValue::Str(units),
                        CMapValue::Other => UniValue::Str(Vec::new()),
                    },
                );
            }
            Ok(Some(ToUnicode::Map(map)))
        }
        Obj::Stream(stream) => {
            let created = stream
                .decode(xref.filters().as_ref(), xref.guard())
                .and_then(|bytes| {
                    CMapFactory::create(Some(CMapEncoding::Stream(&bytes)), None, xref.guard())
                })
                .and_then(|cmap| to_unicode_from_cmap(&cmap));
            match created {
                Ok(to_unicode) => Ok(Some(to_unicode)),
                Err(error) if error.is_fatal() => Err(error),
                Err(error) => {
                    tracing::warn!("readToUnicode - ignoring ToUnicode data: \"{error}\".");
                    Ok(None)
                }
            }
        }
        _ => Ok(None),
    }
}

// ---- simple fonts --------------------------------------------------------------------------------------------------

/// `_simpleFontToUnicode(properties, forceGlyphs)`: the text of each code of a simple font by the glyph name its
/// encoding and `/Differences` give it.
pub fn simple_font_to_unicode(properties: &Properties, force_glyphs: bool) -> ToUnicodeMap {
    let mut encoding: BTreeMap<i64, String> = properties
        .default_encoding
        .iter()
        .enumerate()
        .map(|(code, name)| (code as i64, (*name).to_owned()))
        .collect();
    for (code, glyph_name) in properties.differences.iter() {
        if glyph_name == ".notdef"
            || !is_integer(code)
            || !(0.0..=MAX_ENCODING_CODE as f64).contains(&code)
        {
            continue;
        }
        encoding.insert(code as i64, glyph_name.to_owned());
    }
    let base_encoding = properties
        .base_encoding_name
        .as_deref()
        .and_then(get_encoding);
    let mut to_unicode = ToUnicodeMap::new();
    for (charcode, glyph_name) in &encoding {
        let charcode = *charcode;
        if glyph_name.is_empty() {
            continue;
        }
        if let Some(unicode) = data::glyph_unicode(glyph_name) {
            to_unicode.set(
                charcode as u32,
                UniValue::Str(from_char_code(i64::from(unicode))),
            );
            continue;
        }
        let units = glyph_name.encode_utf16().count();
        let mut code: f64 = 0.0;
        match glyph_name.chars().next() {
            Some('G') => {
                if units == 3 {
                    code = parse_int_hex(&glyph_name[1..]).map_or(f64::NAN, |v| v as f64);
                }
            }
            Some('g') => {
                if units == 5 {
                    code = parse_int_hex(&glyph_name[1..]).map_or(f64::NAN, |v| v as f64);
                }
            }
            Some('C' | 'c') => {
                if (3..=4).contains(&units) {
                    let code_str = &glyph_name[1..];
                    if force_glyphs {
                        code = parse_int_hex(code_str).map_or(f64::NAN, |v| v as f64);
                    } else {
                        code = js_number(code_str).unwrap_or(f64::NAN);
                        if code.is_nan() && parse_int_hex(code_str).is_some() {
                            return simple_font_to_unicode(properties, true);
                        }
                    }
                }
            }
            Some('u') => {
                if let Some(unicode) = data::get_unicode_for_glyph(glyph_name, &GLYPHS_UNICODE) {
                    code = f64::from(unicode);
                }
            }
            _ => {
                if matches!(glyph_name.as_str(), "f_h" | "f_t" | "T_h") {
                    let text: Vec<u16> = glyph_name.replace('_', "").encode_utf16().collect();
                    to_unicode.set(charcode as u32, UniValue::Str(text));
                    continue;
                }
            }
        }
        if code > 0.0 && code <= 1_114_111.0 && is_integer(code) {
            let code = code as i64;
            if base_encoding.is_some() && code == charcode {
                let base_glyph = base_encoding
                    .and_then(|table| table.get(charcode as usize))
                    .filter(|name| !name.is_empty());
                if let Some(base_glyph) = base_glyph {
                    let unicode = data::glyph_unicode(base_glyph).unwrap_or(0);
                    to_unicode.set(
                        charcode as u32,
                        UniValue::Str(from_char_code(i64::from(unicode))),
                    );
                    continue;
                }
            }
            if let Ok(text) = from_code_points(&[code]) {
                to_unicode.set(charcode as u32, UniValue::Str(text));
            }
        }
    }
    to_unicode
}

// ---- building the map of a font ------------------------------------------------------------------------------------

/// `buildToUnicode(properties)`: the ToUnicode map the font ends with. A map the file has is kept (a simple font with an
/// encoding keeps the map its encoding gives as a fallback for the codes the file's map misses); without one a simple
/// font gets its encoding's, a CID font on a predefined CMap or an Adobe CJK ordering gets the one of the
/// `<registry>-<ordering>-UCS2` CMap, and any other CID font the identity.
pub fn build_to_unicode(xref: &Xref, properties: &mut Properties) -> Result<ToUnicode> {
    properties.has_included_to_unicode_map = properties
        .to_unicode
        .as_ref()
        .is_some_and(|to_unicode| to_unicode.size() != 0);
    if properties.has_included_to_unicode_map {
        if !properties.composite && properties.has_encoding {
            properties.fallback_to_unicode = Some(simple_font_to_unicode(properties, false));
        }
        return Ok(properties
            .to_unicode
            .take()
            .expect("a map was included, so there is one"));
    }
    if !properties.composite {
        return Ok(ToUnicode::Map(simple_font_to_unicode(properties, false)));
    }
    let cmap = properties.cmap.as_ref().ok_or_else(|| {
        PdfError::Unknown("Cannot read properties of undefined (reading 'builtInCMap')".to_owned())
    })?;
    let info = properties.cid_system_info.as_ref();
    let adobe_ordering = info.is_some_and(|info| {
        info.registry == "Adobe"
            && matches!(info.ordering.as_str(), "GB1" | "CNS1" | "Japan1" | "Korea1")
    });
    if (cmap.built_in && !cmap.is_identity_kind()) || adobe_ordering {
        let info = info.ok_or_else(|| {
            PdfError::Unknown("Cannot destructure property 'registry' of undefined".to_owned())
        })?;
        let ucs2_name = format!("{}-{}-UCS2", info.registry, info.ordering);
        let ucs2 = CMapFactory::create(Some(CMapEncoding::Name(&ucs2_name)), None, xref.guard())?;
        let mut to_unicode = ToUnicodeMap::new();
        for (code, value) in cmap.get_map() {
            let CMapValue::Cid(cid) = value else {
                continue;
            };
            if cid > 0xffff {
                return Err(PdfError::format("Max size of CID is 65,535"));
            }
            let Ok(cid) = u32::try_from(cid) else {
                continue;
            };
            match ucs2.lookup(cid) {
                Some(CMapValue::Str(units)) => {
                    let text: Vec<u16> = units
                        .chunks(2)
                        .map(|pair| {
                            let low = pair.get(1).map_or(0, |unit| u32::from(*unit));
                            ((u32::from(pair[0]) << 8) + low) as u16
                        })
                        .collect();
                    to_unicode.set(code, UniValue::Str(text));
                }
                Some(CMapValue::Cid(value)) if value != 0 => {
                    to_unicode.set(code, UniValue::Str(Vec::new()));
                }
                _ => {}
            }
        }
        return Ok(ToUnicode::Map(to_unicode));
    }
    Ok(ToUnicode::Identity(IdentityToUnicodeMap {
        first_char: properties.first_char,
        last_char: properties.last_char,
    }))
}

/// `readCidToGidMap(glyphsData, toUnicode)`.
fn read_cid_to_gid_map(glyphs_data: &[u8], to_unicode: &ToUnicode) -> BTreeMap<u32, u32> {
    let mut map = BTreeMap::new();
    for (code, pair) in glyphs_data.chunks(2).enumerate() {
        let low = pair.get(1).map_or(0, |byte| u32::from(*byte));
        let glyph_id = (u32::from(pair[0]) << 8) | low;
        let code = code as u32;
        if glyph_id == 0 && !to_unicode.has(code) {
            continue;
        }
        map.insert(code, glyph_id);
    }
    map
}

/// `stringToPDFString(value)` of a CIDSystemInfo entry: the text of a string, `""` for a value that is not one that
/// pdf.js can index (a name, a number), and the `TypeError` for a missing one.
fn system_info_text(value: &Obj) -> Result<String> {
    match value {
        Obj::Str(bytes) => Ok(data::string_to_pdf_string(bytes, false)),
        Obj::Null => Err(PdfError::Unknown(
            "Cannot read properties of undefined (reading '0')".to_owned(),
        )),
        Obj::Array(items) if !items.is_empty() => Err(PdfError::Unknown(
            "str.charCodeAt is not a function".to_owned(),
        )),
        _ => Ok(String::new()),
    }
}

/// The `/Differences` of an encoding dictionary.
fn read_differences(xref: &Xref, encoding: &Dict, properties: &mut Properties) -> Result<()> {
    let differences = xref.get(encoding, "Differences")?;
    let entries: &[Obj] = match &differences {
        Obj::Array(entries) => entries,
        Obj::Str(bytes) if bytes.is_empty() => &[],
        Obj::Str(_) => {
            return Err(PdfError::format(
                "Invalid entry in 'Differences' array: a string".to_owned(),
            ));
        }
        _ => {
            return Err(PdfError::Unknown("diffEncoding is not iterable".to_owned()));
        }
    };
    let mut index = 0.0;
    for entry in entries {
        match xref.fetch_if_ref(entry, false)? {
            Obj::Num(number) => index = number,
            Obj::Name(name) => {
                properties.differences.set(index, name.to_string());
                index += 1.0;
            }
            other => {
                return Err(PdfError::format(format!(
                    "Invalid entry in 'Differences' array: {other:?}"
                )));
            }
        }
    }
    Ok(())
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

/// `extractDataStructures(dict, properties)`: reads the `/ToUnicode`, the CID system info and `/CIDToGIDMap` of a CID
/// font, the base encoding and `/Differences`, chooses the default encoding, and builds the ToUnicode map.
pub fn extract_data_structures(
    xref: &Xref,
    dict: &Dict,
    properties: &mut Properties,
) -> Result<()> {
    let to_unicode = read_to_unicode(xref, &properties.to_unicode_obj)?;
    let mut cid_to_gid_bytes = None;
    if properties.composite {
        if let Obj::Dict(cid_system_info) = xref.get(dict, "CIDSystemInfo")?
            && properties.cid_system_info.is_none()
        {
            properties.cid_system_info = Some(CidSystemInfo {
                registry: system_info_text(&xref.get(&cid_system_info, "Registry")?)?,
                ordering: system_info_text(&xref.get(&cid_system_info, "Ordering")?)?,
            });
        }
        match xref.get(dict, "CIDToGIDMap") {
            Ok(Obj::Stream(stream)) => match stream.decode(xref.filters().as_ref(), xref.guard()) {
                Ok(bytes) => cid_to_gid_bytes = Some(bytes),
                Err(error) if error.is_fatal() => return Err(error),
                Err(error) => {
                    tracing::warn!(
                        "extractDataStructures - ignoring CIDToGIDMap data: \"{error}\"."
                    );
                }
            },
            Ok(_) => {}
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => {
                tracing::warn!("extractDataStructures - ignoring CIDToGIDMap data: \"{error}\".");
            }
        }
    }
    let mut base_encoding_name: Option<String> = None;
    if dict.has("Encoding") {
        match xref.get(dict, "Encoding")? {
            Obj::Dict(encoding) => {
                if let Obj::Name(name) = xref.get(&encoding, "BaseEncoding")? {
                    base_encoding_name = Some(name.to_string());
                }
                if encoding.has("Differences") {
                    read_differences(xref, &encoding, properties)?;
                }
            }
            Obj::Name(name) => base_encoding_name = Some(name.to_string()),
            _ => tracing::warn!("Encoding is not a Name nor a Dict"),
        }
        if !matches!(
            base_encoding_name.as_deref(),
            Some("MacRomanEncoding" | "MacExpertEncoding" | "WinAnsiEncoding")
        ) {
            base_encoding_name = None;
        }
    }
    let non_embedded_font = !properties.has_file || properties.is_internal_font;
    let is_symbols_font_name = data::contains_name(&SYMBOLS_FONTS, &properties.name);
    if base_encoding_name.is_some() && non_embedded_font && is_symbols_font_name {
        base_encoding_name = None;
    }
    if base_encoding_name.as_deref() == Some("WinAnsiEncoding")
        && non_embedded_font
        && properties
            .name
            .chars()
            .next()
            .is_some_and(|ch| u32::from(ch) >= 0xb7)
        && CHINESE_FONT_NAMES.contains(&properties.name.as_str())
    {
        base_encoding_name = None;
        let cmap = CMapFactory::create(Some(CMapEncoding::Name("GBK-EUC-H")), None, xref.guard())?;
        properties.composite = true;
        properties.cid_encoding = Some("GBK-EUC-H".to_owned());
        properties.vertical = cmap.vertical;
        properties.cmap = Some(cmap);
        properties.cid_system_info = Some(CidSystemInfo {
            registry: "Adobe".to_owned(),
            ordering: "GB1".to_owned(),
        });
    }
    if let Some(name) = base_encoding_name.as_deref() {
        properties.default_encoding = get_encoding(name).expect("the three names are encodings");
    } else {
        let mut is_symbolic_font = properties.flags & font_flags::SYMBOLIC as i32 != 0;
        let is_nonsymbolic_font = properties.flags & font_flags::NONSYMBOLIC as i32 != 0;
        if properties.ty == "TrueType"
            && is_symbolic_font
            && is_nonsymbolic_font
            && properties.differences.size() > 0
        {
            properties.flags &= !(font_flags::SYMBOLIC as i32);
            is_symbolic_font = false;
        }
        let mut encoding = &STANDARD_ENCODING;
        if properties.ty == "TrueType" && !is_nonsymbolic_font {
            encoding = &WIN_ANSI_ENCODING;
        }
        if is_symbolic_font || is_symbols_font_name {
            encoding = &MAC_ROMAN_ENCODING;
            if non_embedded_font {
                if contains_ignore_case(&properties.name, "symbol") {
                    encoding = &SYMBOL_SET_ENCODING;
                } else if contains_ignore_case(&properties.name, "dingbats") {
                    encoding = &ZAPF_DINGBATS_ENCODING;
                } else if contains_ignore_case(&properties.name, "wingdings") {
                    encoding = &WIN_ANSI_ENCODING;
                }
            }
        }
        properties.default_encoding = encoding;
    }
    properties.has_encoding = base_encoding_name.is_some() || properties.differences.size() > 0;
    properties.base_encoding_name = base_encoding_name;
    properties.to_unicode = to_unicode;
    let built = build_to_unicode(xref, properties)?;
    if let Some(bytes) = cid_to_gid_bytes {
        properties.cid_to_gid_map = Some(read_cid_to_gid_map(&bytes, &built));
    }
    properties.to_unicode = Some(built);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn str_of(value: Option<&UniValue>) -> String {
        match value {
            Some(UniValue::Str(units)) => String::from_utf16_lossy(units),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn a_map_keeps_the_order_of_its_first_entries() {
        let mut map = ToUnicodeMap::new();
        map.set(5, UniValue::Str(vec![0x41]));
        map.set(3, UniValue::Str(vec![0x42]));
        map.set(5, UniValue::Str(vec![0x43]));
        assert_eq!(map.size(), 2);
        assert_eq!(
            map.iter().map(|(code, _)| code).collect::<Vec<_>>(),
            vec![5, 3]
        );
        assert_eq!(map.char_code_of(&UniValue::Str(vec![0x42])), 3);
        assert_eq!(map.char_code_of(&UniValue::Str(vec![0x41])), -1);
        let mut seen = Vec::new();
        map.for_each(|code, point| seen.push((code, point)))
            .unwrap();
        assert_eq!(seen, vec![(5, Some(0x43)), (3, Some(0x42))]);
    }

    #[test]
    fn for_each_gives_the_first_code_point_and_fails_on_a_number() {
        let mut map = ToUnicodeMap::new();
        map.set(1, UniValue::Str(vec![0xd83d, 0xde00, 0x41]));
        map.set(2, UniValue::Str(Vec::new()));
        let mut seen = Vec::new();
        map.for_each(|code, point| seen.push((code, point)))
            .unwrap();
        assert_eq!(seen, vec![(1, Some(0x1f600)), (2, None)]);
        map.set(3, UniValue::Code(65));
        assert!(map.for_each(|_, _| {}).is_err());
    }

    #[test]
    fn the_identity_map_covers_its_range_only() {
        let identity = ToUnicode::Identity(IdentityToUnicodeMap {
            first_char: 32,
            last_char: 126,
        });
        assert_eq!(identity.size(), 95);
        assert!(identity.has(65) && !identity.has(31));
        assert_eq!(str_of(identity.get(65).as_ref()), "A");
        assert_eq!(identity.char_code_of(&UniValue::Code(66)), 66);
        assert_eq!(identity.char_code_of(&UniValue::Code(200)), -1);
        assert_eq!(identity.char_code_of(&UniValue::Str(vec![66])), -1);
    }

    #[test]
    fn javascript_number_parsing_of_glyph_name_suffixes() {
        assert_eq!(js_number("12"), Some(12.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number(" 7"), Some(7.0));
        assert_eq!(js_number("1e1"), Some(10.0));
        assert_eq!(js_number("0x1f"), Some(31.0));
        assert_eq!(js_number("1f"), None);
        assert_eq!(js_number("inf"), None);
        assert_eq!(parse_int_hex("1f"), Some(31));
        assert_eq!(parse_int_hex("1fz"), Some(31));
        assert_eq!(parse_int_hex("zz"), None);
    }

    #[test]
    fn code_points_become_utf16() {
        assert_eq!(
            from_code_points(&[0x41, 0x1f600]).unwrap(),
            vec![0x41, 0xd83d, 0xde00]
        );
        assert!(from_code_points(&[0x11_0000]).is_err());
        assert!(from_code_points(&[-1]).is_err());
        assert_eq!(from_code_points(&[0xd800]).unwrap(), vec![0xd800]);
        assert_eq!(from_char_code(0x1_0041), vec![0x41]);
    }

    #[test]
    fn a_simple_font_reads_its_encoding_and_differences() {
        let mut properties = Properties {
            default_encoding: &WIN_ANSI_ENCODING,
            base_encoding_name: Some("WinAnsiEncoding".to_owned()),
            ..Properties::default()
        };
        properties.differences.set(65.0, "uni0042".to_owned());
        properties.differences.set(66.0, "g41".to_owned());
        properties.differences.set(67.0, "c67".to_owned());
        properties.differences.set(68.0, "f_h".to_owned());
        properties.differences.set(69.0, ".notdef".to_owned());
        let map = simple_font_to_unicode(&properties, false);
        assert_eq!(str_of(map.get(0x20)), " ");
        assert_eq!(str_of(map.get(65)), "B");
        assert_eq!(str_of(map.get(68)), "fh");
        // `.notdef` leaves the base encoding's glyph for the code alone.
        assert_eq!(str_of(map.get(69)), "E");
        // "g41" has the wrong length for a g name (4 digits) and names nothing; "c67" is decimal 67, the code itself,
        // which the base encoding turns into its own glyph.
        assert!(map.get(66).is_none());
        assert_eq!(str_of(map.get(67)), "C");
        // A c name that is only hex ("c4f") makes pdf.js read every c and g name as hex.
        let mut hex = Properties {
            default_encoding: &STANDARD_ENCODING,
            ..Properties::default()
        };
        hex.differences.set(1.0, "c4f".to_owned());
        hex.differences.set(2.0, "c20".to_owned());
        let map = simple_font_to_unicode(&hex, false);
        assert_eq!(str_of(map.get(1)), "O");
        assert_eq!(str_of(map.get(2)), " ");
    }
}
