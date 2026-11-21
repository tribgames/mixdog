//! The Type 1 font-program reader, ported from pdf.js 6.4.299 (`src/core/type1_parser.js`: `Type1Parser`,
//! `Type1CharString`, `decrypt`, `decryptAscii`; `src/core/type1_font.js`: `Type1Font`, `getHeaderBlock`,
//! `getEexecBlock`, `isCidKeyedType1File`).
//!
//! What text extraction reads from a Type 1 program is read here: the cleartext `/Encoding` (a named base encoding
//! or the `dup` entries), `/FontMatrix` and `/FontBBox`; after the `eexec` decryption (binary or hexadecimal, with
//! or without the PFB segment headers) the `/lenIV`, the `/Subrs` and the `/CharStrings` with their names and widths
//! (the `hsbw` and `sbw` of the charstring, found by the same stack machine pdf.js uses, including flex, `div`,
//! `callsubr` and seac); and the CID-keyed Type 1 layout (`StartData` with a CIDMap). The Type 2 charstrings and the
//! CFF wrapper pdf.js builds for the browser's font loader are not part of text extraction and are not ported.

use std::collections::BTreeMap;

use super::cff::{js_parse_float, js_parse_int, js_to_int32};
use crate::error::{PdfError, Result};
use crate::fonts::data::encodings::get_encoding;

const EEXEC_ENCRYPT_KEY: u16 = 55665;
const CHAR_STRS_ENCRYPT_KEY: u16 = 4330;
/// Nesting of `callsubr` beyond which the walk stops: pdf.js recurses until the JavaScript stack overflows, which
/// throws and fails the font; no real program nests more than a few levels (the Type 1 limit is 10). The bound
/// keeps the recursion well inside a worker thread's stack.
const MAX_CHARSTRING_DEPTH: usize = 1000;

/// The font properties the reader reads and sets (`properties` of `Type1Font`).
#[derive(Debug, Clone, Default)]
pub struct Type1Properties {
    /// `Length1` of the FontFile stream's dictionary.
    pub length1: Option<f64>,
    /// A composite (Type0) font: a CID-keyed Type 1 file is then read as such.
    pub composite: bool,
    pub first_char: i64,
    pub last_char: i64,
    /// `widths` of the font (character code to width): a code the dictionary left out and the program knows gets
    /// the width of the glyph the built-in encoding names for it.
    pub widths: BTreeMap<i64, f64>,
    /// Set from `/FontMatrix`.
    pub font_matrix: Option<Vec<f64>>,
    /// Set from `/Encoding`: character code to glyph name.
    pub built_in_encoding: Option<BTreeMap<u32, String>>,
    /// Set from `/FontBBox`.
    pub ascent: Option<f64>,
    pub descent: Option<f64>,
    pub ascent_scaled: bool,
}

/// One glyph of the program (a `charstrings` entry of pdf.js's font program, without the Type 2 bytes).
#[derive(Debug, Clone)]
pub struct Type1Glyph {
    pub glyph_name: Option<String>,
    /// The width the charstring's `hsbw` or `sbw` gave (0 where it gave none).
    pub width: f64,
    pub lsb: f64,
    /// `adx ady bchar achar` of a glyph that ends with seac.
    pub seac: Option<Vec<f64>>,
    /// Whether pdf.js's converted charstring has any byte (`charstring.length > 0`).
    has_charstring: bool,
}

/// `Type1Font`.
#[derive(Debug, Clone)]
pub struct Type1Font {
    /// The glyphs after glyph 0 (`.notdef` first when the program has one).
    pub charstrings: Vec<Type1Glyph>,
    /// Glyph id (index + 1) to the seac values.
    pub seacs: BTreeMap<usize, Vec<f64>>,
}

impl Type1Font {
    /// `new Type1Font(name, file, properties)`: read the program in `bytes`.
    pub fn parse(bytes: &[u8], properties: &mut Type1Properties) -> Result<Type1Font> {
        let mut file = Stream::new(bytes.to_vec());
        let mut glyphs = None;
        if properties.composite && is_cid_keyed_type1_file(&file) {
            glyphs = parse_cid_keyed_type1(&file, properties)?;
        }
        let glyphs = match glyphs {
            Some(glyphs) => glyphs,
            None => parse_type1(&mut file, properties)?,
        };
        let seacs = glyphs.iter().enumerate().filter_map(|(i, g)| g.seac.clone().map(|s| (i + 1, s))).collect();
        Ok(Type1Font { charstrings: glyphs, seacs })
    }

    /// `numGlyphs`.
    pub fn num_glyphs(&self) -> usize {
        self.charstrings.len() + 1
    }

    /// `getCharset`: the glyph names, `.notdef` first.
    pub fn charset(&self) -> Vec<Option<String>> {
        let mut charset = vec![Some(".notdef".to_owned())];
        charset.extend(self.charstrings.iter().map(|g| g.glyph_name.clone()));
        charset
    }

    /// `hasGlyphId`.
    pub fn has_glyph_id(&self, id: i64) -> bool {
        if id < 0 || id >= self.num_glyphs() as i64 {
            return false;
        }
        if id == 0 {
            return true;
        }
        self.charstrings[id as usize - 1].has_charstring
    }

    /// The composite branch of `Type1Font.getGlyphMapping`: character code to glyph id (`glyphId + 1`).
    /// `char_code_of` is `cMap.charCodeOf`.
    pub fn composite_glyph_mapping(&self, char_code_of: impl Fn(u32) -> i64) -> BTreeMap<i64, usize> {
        (0..self.charstrings.len()).map(|glyph_id| (char_code_of(glyph_id as u32), glyph_id + 1)).collect()
    }

    /// The first part of the simple branch of `Type1Font.getGlyphMapping`: the glyph id of each name of the
    /// built-in encoding that the program has (`type1FontGlyphMapping` takes it from there).
    pub fn built_in_glyph_ids(&self, properties: &Type1Properties) -> Option<BTreeMap<u32, usize>> {
        let encoding = properties.built_in_encoding.as_ref()?;
        let mut first_id: BTreeMap<&str, usize> = BTreeMap::new();
        first_id.insert(".notdef", 0);
        for (i, glyph) in self.charstrings.iter().enumerate() {
            if let Some(name) = glyph.glyph_name.as_deref() {
                first_id.entry(name).or_insert(i + 1);
            }
        }
        Some(encoding.iter().filter_map(|(&code, name)| first_id.get(name.as_str()).map(|&id| (code, id))).collect())
    }
}

// ---- stream and decryption ----------------------------------------------------------------------------------------

/// `Stream` of pdf.js over a byte buffer.
struct Stream {
    bytes: Vec<u8>,
    pos: i64,
}

impl Stream {
    fn new(bytes: Vec<u8>) -> Self {
        Stream { bytes, pos: 0 }
    }

    fn end(&self) -> i64 {
        self.bytes.len() as i64
    }

    /// `getByte`: -1 at the end.
    fn get_byte(&mut self) -> i32 {
        if self.pos >= self.end() {
            return -1;
        }
        let byte = usize::try_from(self.pos).ok().and_then(|p| self.bytes.get(p)).map_or(-1, |&b| i32::from(b));
        self.pos += 1;
        byte
    }

    /// `getBytes(length)`; no length, 0 or `NaN` reads to the end.
    fn get_bytes(&mut self, length: Option<f64>) -> Vec<u8> {
        let pos = self.pos;
        let end_pos = match length {
            Some(l) if l != 0.0 && !l.is_nan() => ((pos as f64 + l).min(self.end() as f64)) as i64,
            _ => self.end(),
        };
        self.pos = end_pos;
        let from = pos.clamp(0, self.end()) as usize;
        let to = end_pos.clamp(0, self.end()) as usize;
        if to <= from { Vec::new() } else { self.bytes[from..to].to_vec() }
    }

    /// `peekBytes(length)`.
    fn peek_bytes(&mut self, length: usize) -> Vec<u8> {
        let bytes = self.get_bytes(Some(length as f64));
        self.pos -= bytes.len() as i64;
        bytes
    }

    /// `skip(n)`.
    fn skip(&mut self, n: i64) {
        self.pos += if n == 0 { 1 } else { n };
    }
}

fn is_white_space(ch: i32) -> bool {
    ch == 0x20 || ch == 0x09 || ch == 0x0d || ch == 0x0a
}

fn is_hex_digit(code: Option<i32>) -> bool {
    matches!(code, Some(c) if (48..=57).contains(&c) || (65..=70).contains(&c) || (97..=102).contains(&c))
}

fn is_special(c: i32) -> bool {
    matches!(c, 0x2f | 0x5b | 0x5d | 0x7b | 0x7d | 0x28 | 0x29)
}

/// `decrypt(data, key, discardNumber)`.
fn decrypt(data: &[u8], key: u16, discard: usize) -> Vec<u8> {
    if discard >= data.len() {
        return Vec::new();
    }
    const C1: u32 = 52845;
    const C2: u32 = 22719;
    let mut r = u32::from(key);
    for &b in &data[..discard] {
        r = ((u32::from(b) + r) * C1 + C2) & 0xffff;
    }
    data[discard..]
        .iter()
        .map(|&value| {
            let out = value ^ (r >> 8) as u8;
            r = ((u32::from(value) + r) * C1 + C2) & 0xffff;
            out
        })
        .collect()
}

/// `decryptAscii(data, key, discardNumber)`.
fn decrypt_ascii(data: &[u8], key: u16, discard: usize) -> Vec<u8> {
    const C1: u32 = 52845;
    const C2: u32 = 22719;
    let hex = |b: u8| is_hex_digit(Some(i32::from(b)));
    let mut r = u32::from(key);
    let count = data.len();
    let mut decrypted = Vec::with_capacity(count / 2);
    let mut i = 0;
    while i < count {
        let digit1 = data[i];
        if !hex(digit1) {
            i += 1;
            continue;
        }
        i += 1;
        let mut digit2 = 0;
        while i < count {
            digit2 = data[i];
            if hex(digit2) {
                break;
            }
            i += 1;
        }
        if i < count {
            let value = hex_value(digit1) * 16 + hex_value(digit2);
            decrypted.push(value as u8 ^ (r >> 8) as u8);
            r = ((value + r) * C1 + C2) & 0xffff;
        }
        i += 1;
    }
    decrypted.drain(..discard.min(decrypted.len()));
    decrypted
}

fn hex_value(b: u8) -> u32 {
    match b {
        b'0'..=b'9' => u32::from(b - b'0'),
        b'a'..=b'f' => u32::from(b - b'a') + 10,
        _ => u32::from(b - b'A') + 10,
    }
}

/// `Type1Parser.readCharStrings(bytes, lenIV)`. A `lenIV` that is not an integer from -1 up is not a value a
/// program has; it is read as pdf.js reads `NaN` (no bytes) or as 0.
fn read_char_strings(bytes: &[u8], len_iv: f64) -> Vec<u8> {
    if len_iv == -1.0 {
        return bytes.to_vec();
    }
    if len_iv.is_nan() {
        return Vec::new();
    }
    decrypt(bytes, CHAR_STRS_ENCRYPT_KEY, len_iv.max(0.0) as usize)
}

// ---- the charstring machine ---------------------------------------------------------------------------------------

/// `Type1CharString`: runs a charstring as `convert` does, keeping what text extraction needs (width, left side
/// bearing, seac, whether any command was emitted).
#[derive(Default)]
struct CharString {
    width: f64,
    lsb: f64,
    flexing: bool,
    has_output: bool,
    stack: Vec<f64>,
    seac: Option<Vec<f64>>,
}

impl CharString {
    /// `convert`: `Ok(true)` is pdf.js's `error`.
    fn convert(&mut self, encoded: &[u8], subrs: &BTreeMap<i32, Vec<u8>>, depth: usize) -> Result<bool> {
        if depth > MAX_CHARSTRING_DEPTH {
            return Err(PdfError::Unknown("RangeError: Maximum call stack size exceeded".to_owned()));
        }
        let count = encoded.len();
        let mut error = false;
        let mut i = 0;
        while i < count {
            let mut value = f64::from(encoded[i]);
            if encoded[i] < 32 {
                let mut op = i64::from(encoded[i]);
                if op == 12 {
                    i += 1;
                    op = match encoded.get(i) {
                        Some(&b) => (12 << 8) + i64::from(b),
                        None => -1,
                    };
                }
                match op {
                    1 | 3 | 0x0c00 | 0x0c01 | 0x0c02 | 0x0c21 => self.stack.clear(),
                    4 => {
                        if self.flexing {
                            match self.stack.pop() {
                                Some(dy) => {
                                    self.stack.push(0.0);
                                    self.stack.push(dy);
                                }
                                None => error = true,
                            }
                        } else {
                            error = self.execute_command(1, false);
                        }
                    }
                    5 => error = self.execute_command(2, false),
                    6 | 7 => error = self.execute_command(1, false),
                    8 => error = self.execute_command(6, false),
                    9 => self.stack.clear(),
                    10 => match self.stack.pop() {
                        None => error = true,
                        Some(subr_number) => match subr(subrs, subr_number) {
                            None => error = true,
                            Some(code) => error = self.convert(code, subrs, depth + 1)?,
                        },
                    },
                    11 => return Ok(error),
                    13 => {
                        if self.stack.len() < 2 {
                            error = true;
                        } else {
                            let wx = self.stack.pop().unwrap_or(f64::NAN);
                            let sbx = self.stack.pop().unwrap_or(f64::NAN);
                            self.lsb = sbx;
                            self.width = wx;
                            self.stack.push(wx);
                            self.stack.push(sbx);
                            error = self.execute_command(2, false);
                        }
                    }
                    14 => self.has_output = true,
                    21 => {
                        if !self.flexing {
                            error = self.execute_command(2, false);
                        }
                    }
                    22 => {
                        if self.flexing {
                            self.stack.push(0.0);
                        } else {
                            error = self.execute_command(1, false);
                        }
                    }
                    30 | 31 => error = self.execute_command(4, false),
                    0x0c06 => {
                        let len = self.stack.len();
                        let asb = if len >= 5 { self.stack[len - 5] } else { f64::NAN };
                        let mut seac = self.stack.split_off(len.saturating_sub(4));
                        if seac.is_empty() {
                            seac.push(f64::NAN);
                        } else {
                            seac[0] += self.lsb - asb;
                        }
                        self.seac = Some(seac);
                        error = self.execute_command(0, false);
                    }
                    0x0c07 => {
                        if self.stack.len() < 4 {
                            error = true;
                        } else {
                            self.stack.pop();
                            let wx = self.stack.pop().unwrap_or(f64::NAN);
                            let sby = self.stack.pop().unwrap_or(f64::NAN);
                            let sbx = self.stack.pop().unwrap_or(f64::NAN);
                            self.lsb = sbx;
                            self.width = wx;
                            self.stack.push(wx);
                            self.stack.push(sbx);
                            self.stack.push(sby);
                            error = self.execute_command(3, false);
                        }
                    }
                    0x0c0c => {
                        if self.stack.len() < 2 {
                            error = true;
                        } else {
                            let num2 = self.stack.pop().unwrap_or(f64::NAN);
                            let num1 = self.stack.pop().unwrap_or(f64::NAN);
                            self.stack.push(num1 / num2);
                        }
                    }
                    0x0c10 => {
                        if self.stack.len() < 2 {
                            error = true;
                        } else {
                            let subr_number = self.stack.pop().unwrap_or(f64::NAN);
                            let num_args = self.stack.pop().unwrap_or(f64::NAN);
                            if subr_number == 0.0 && num_args == 3.0 {
                                let len = self.stack.len();
                                let f = self.stack.split_off(len.saturating_sub(17));
                                let a = |k: usize| f.get(k).copied().unwrap_or(f64::NAN);
                                self.stack.push(a(2) + a(0));
                                self.stack.push(a(3) + a(1));
                                for k in 4..=14 {
                                    self.stack.push(a(k));
                                }
                                error = self.execute_command(13, true);
                                self.flexing = false;
                                self.stack.push(a(15));
                                self.stack.push(a(16));
                            } else if subr_number == 1.0 && num_args == 0.0 {
                                self.flexing = true;
                            }
                        }
                    }
                    0x0c11 => {}
                    _ => {
                        tracing::warn!("Unknown type 1 charstring command of \"{op}\"");
                    }
                }
                if error {
                    break;
                }
                i += 1;
                continue;
            } else if encoded[i] <= 246 {
                value -= 139.0;
            } else if encoded[i] <= 250 {
                i += 1;
                value = match encoded.get(i) {
                    Some(&b) => (value - 247.0) * 256.0 + f64::from(b) + 108.0,
                    None => f64::NAN,
                };
            } else if encoded[i] <= 254 {
                i += 1;
                value = match encoded.get(i) {
                    Some(&b) => -((value - 251.0) * 256.0) - f64::from(b) - 108.0,
                    None => f64::NAN,
                };
            } else {
                let mut word: i32 = 0;
                for _ in 0..4 {
                    i += 1;
                    word = (word << 8) | i32::from(encoded.get(i).copied().unwrap_or(0));
                }
                value = f64::from(word);
            }
            self.stack.push(value);
            i += 1;
        }
        Ok(error)
    }

    /// `executeCommand(howManyArgs, command, keepStack)`: `true` is pdf.js's error.
    fn execute_command(&mut self, how_many: usize, keep_stack: bool) -> bool {
        let len = self.stack.len();
        if how_many > len {
            return true;
        }
        self.has_output = true;
        if keep_stack {
            self.stack.truncate(len - how_many);
        } else {
            self.stack.clear();
        }
        false
    }
}

/// `subrs[subrNumber]`.
fn subr(subrs: &BTreeMap<i32, Vec<u8>>, number: f64) -> Option<&[u8]> {
    if number.fract() != 0.0 || number < f64::from(i32::MIN) || number > f64::from(i32::MAX) {
        return None;
    }
    subrs.get(&(number as i32)).map(Vec::as_slice)
}

// ---- the parser ---------------------------------------------------------------------------------------------------

/// `Type1Parser` with seac analysis on, as pdf.js runs it.
struct Type1Parser {
    stream: Stream,
    current_char: i32,
}

/// One charstring found in the program, before it is run.
struct FoundCharString {
    glyph: Option<String>,
    encoded: Vec<u8>,
}

impl Type1Parser {
    fn new(mut stream: Stream, encrypted: bool) -> Self {
        if encrypted {
            let data = stream.get_bytes(None);
            let at = |i: usize| data.get(i).map(|&b| i32::from(b));
            let first_ok = is_hex_digit(at(0)) || at(0).is_some_and(is_white_space);
            let is_binary = !(first_ok && (1..8).all(|i| is_hex_digit(at(i))));
            stream = Stream::new(if is_binary { decrypt(&data, EEXEC_ENCRYPT_KEY, 4) } else { decrypt_ascii(&data, EEXEC_ENCRYPT_KEY, 4) });
        }
        let mut parser = Type1Parser { stream, current_char: -1 };
        parser.next_char();
        parser
    }

    fn next_char(&mut self) -> i32 {
        self.current_char = self.stream.get_byte();
        self.current_char
    }

    fn prev_char(&mut self) -> i32 {
        self.stream.skip(-2);
        self.stream.pos = self.stream.pos.max(0);
        self.current_char = self.stream.get_byte();
        self.current_char
    }

    fn get_token(&mut self) -> Option<String> {
        let mut comment = false;
        let mut ch = self.current_char;
        loop {
            if ch == -1 {
                return None;
            }
            if comment {
                if ch == 0x0a || ch == 0x0d {
                    comment = false;
                }
            } else if ch == 0x25 {
                comment = true;
            } else if !is_white_space(ch) {
                break;
            }
            ch = self.next_char();
        }
        if is_special(ch) {
            self.next_char();
            return Some(char::from(ch as u8).to_string());
        }
        let mut token = String::new();
        loop {
            token.push(char::from(ch as u8));
            ch = self.next_char();
            if !(ch >= 0 && !is_white_space(ch) && !is_special(ch)) {
                break;
            }
        }
        Some(token)
    }

    /// `readNumberArray`.
    fn read_number_array(&mut self) -> Vec<f64> {
        self.get_token();
        let mut array = Vec::new();
        loop {
            let token = self.get_token();
            match token.as_deref() {
                None | Some("]") | Some("}") => break,
                Some(t) => array.push(js_parse_float(t)),
            }
        }
        array
    }

    /// `readNumber`: `parseFloat(token || 0)`.
    fn read_number(&mut self) -> f64 {
        match self.get_token() {
            Some(t) => js_parse_float(&t),
            None => 0.0,
        }
    }

    /// `readInt`: `parseInt(token || 0, 10) | 0`.
    fn read_int(&mut self) -> i32 {
        match self.get_token() {
            Some(t) => js_to_int32(js_parse_int(&t)),
            None => 0,
        }
    }

    /// The numeric and boolean entries of the Private dictionary of pdf.js's `extractFontProgram`: what each key
    /// reads from the stream, and the value of `lenIV`.
    fn read_private_entry(&mut self, token: &str, len_iv: &mut f64) {
        match token {
            "BlueValues" | "OtherBlues" | "FamilyBlues" | "FamilyOtherBlues" | "StemSnapH" | "StemSnapV" | "StdHW" | "StdVW" => {
                self.read_number_array();
            }
            "lenIV" => *len_iv = self.read_number(),
            "BlueShift" | "BlueFuzz" | "BlueScale" | "LanguageGroup" | "ExpansionFactor" => {
                self.read_number();
            }
            "ForceBold" => {
                self.get_token();
            }
            _ => {}
        }
    }

    /// `extractFontProgram`: the glyphs of an `eexec` section.
    fn extract_font_program(&mut self, properties: &mut Type1Properties) -> Result<Vec<Type1Glyph>> {
        let mut subrs: BTreeMap<i32, Vec<u8>> = BTreeMap::new();
        let mut found: Vec<FoundCharString> = Vec::new();
        let mut len_iv = 4.0f64;
        let mut subrs_parsed = false;
        let mut char_strings_parsed = false;
        while let Some(token) = self.get_token() {
            if token != "/" {
                continue;
            }
            let Some(token) = self.get_token() else {
                continue;
            };
            match token.as_str() {
                "CharStrings" => {
                    if char_strings_parsed {
                        continue;
                    }
                    char_strings_parsed = true;
                    for _ in 0..4 {
                        self.get_token();
                    }
                    loop {
                        let token = self.get_token();
                        match token.as_deref() {
                            None | Some("end") => break,
                            Some("/") => {}
                            Some(_) => continue,
                        }
                        let glyph = self.get_token();
                        let length = self.read_int();
                        self.get_token();
                        let data = self.read_bytes(length);
                        let encoded = read_char_strings(&data, len_iv);
                        self.next_char();
                        let token = self.get_token();
                        match token.as_deref() {
                            Some("noaccess") => {
                                self.get_token();
                            }
                            Some("/") => {
                                self.prev_char();
                            }
                            _ => {}
                        }
                        found.push(FoundCharString { glyph, encoded });
                    }
                }
                "Subrs" => {
                    if subrs_parsed {
                        continue;
                    }
                    subrs_parsed = true;
                    self.read_int();
                    self.get_token();
                    while self.get_token().as_deref() == Some("dup") {
                        let index = self.read_int();
                        let length = self.read_int();
                        self.get_token();
                        let data = self.read_bytes(length);
                        let encoded = read_char_strings(&data, len_iv);
                        self.next_char();
                        if self.get_token().as_deref() == Some("noaccess") {
                            self.get_token();
                        }
                        subrs.insert(index, encoded);
                    }
                }
                other => self.read_private_entry(other, &mut len_iv),
            }
        }
        let mut glyphs: Vec<Type1Glyph> = Vec::new();
        for FoundCharString { glyph, encoded } in found {
            let mut charstring = CharString::default();
            let error = charstring.convert(&encoded, &subrs, 0)?;
            let glyph_record = Type1Glyph {
                glyph_name: glyph.clone(),
                width: charstring.width,
                lsb: charstring.lsb,
                seac: charstring.seac.take(),
                has_charstring: error || charstring.has_output,
            };
            if glyph.as_deref() == Some(".notdef") {
                glyphs.insert(0, glyph_record);
            } else {
                glyphs.push(glyph_record);
            }
            if let (Some(encoding), Some(name)) = (&properties.built_in_encoding, glyph.as_deref())
                && let Some((&index, _)) = encoding.iter().find(|(_, n)| n.as_str() == name)
            {
                let index = i64::from(index);
                if !properties.widths.contains_key(&index) && index >= properties.first_char && index <= properties.last_char {
                    properties.widths.insert(index, charstring.width);
                }
            }
        }
        Ok(glyphs)
    }

    /// `length > 0 ? stream.getBytes(length) : new Uint8Array(0)`.
    fn read_bytes(&mut self, length: i32) -> Vec<u8> {
        if length > 0 { self.stream.get_bytes(Some(f64::from(length))) } else { Vec::new() }
    }

    /// The `StartData` section of a CID-keyed file: `length` binary bytes, or `length` bytes decoded from the
    /// hexadecimal digits that follow (`None` when they are fewer).
    fn read_start_data(&mut self, length: f64, is_hex: bool) -> Option<Vec<u8>> {
        let binary = self.stream.get_bytes(if is_hex { None } else { Some(length) });
        if !is_hex {
            return Some(binary);
        }
        let wanted = length as usize;
        let mut decoded = vec![0u8; wanted];
        let mut digit1: Option<u8> = None;
        let mut j = 0;
        for &digit in &binary {
            if j >= wanted {
                break;
            }
            if !is_hex_digit(Some(i32::from(digit))) {
                continue;
            }
            match digit1.take() {
                None => digit1 = Some(digit),
                Some(first) => {
                    decoded[j] = (hex_value(first) * 16 + hex_value(digit)) as u8;
                    j += 1;
                }
            }
        }
        (j == wanted).then_some(decoded)
    }

    /// `extractCidKeyedFontProgram`: the glyphs of a CID-keyed Type 1 file, `None` where the file is not one this
    /// layout can be read from.
    fn extract_cid_keyed_font_program(&mut self, properties: &mut Type1Properties) -> Result<Option<Vec<Type1Glyph>>> {
        let mut len_iv = 4.0f64;
        let mut cid_count: i64 = 0;
        let mut cid_map_offset: i64 = -1;
        let mut fd_bytes: i64 = 1;
        let mut gd_bytes: i64 = 0;
        let mut subr_map_offset: i64 = -1;
        let mut sd_bytes: i64 = 0;
        let mut subr_count: i64 = 0;
        let mut start_data_length = 0.0f64;
        let mut start_data_is_hex = false;
        let mut found_start_data = false;
        let mut previous: Vec<Option<String>> = Vec::new();
        fn remember(previous: &mut Vec<Option<String>>, token: Option<String>) {
            previous.push(token);
            if previous.len() > 4 {
                previous.remove(0);
            }
        }
        fn from_end(previous: &[Option<String>], n: usize) -> Option<&str> {
            previous.len().checked_sub(n).and_then(|at| previous[at].as_deref())
        }
        while let Some(token) = self.get_token() {
            if token == "StartData" {
                let data_type = from_end(&previous, 3);
                let data_length = from_end(&previous, 1);
                let digits = data_length.is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
                if from_end(&previous, 4) != Some("(") || from_end(&previous, 2) != Some(")") || !matches!(data_type, Some("Binary" | "Hex")) || !digits {
                    return Ok(None);
                }
                start_data_length = js_parse_int(data_length.unwrap_or("0"));
                if start_data_length <= 0.0 {
                    return Ok(None);
                }
                start_data_is_hex = data_type == Some("Hex");
                found_start_data = true;
                break;
            }
            remember(&mut previous, Some(token.clone()));
            if token != "/" {
                continue;
            }
            let token = self.get_token();
            remember(&mut previous, token.clone());
            match token.as_deref() {
                Some("FontMatrix") => properties.font_matrix = Some(self.read_number_array()),
                Some("FontBBox") => {
                    let bbox = self.read_number_array();
                    set_ascent_descent(properties, &bbox);
                }
                Some("CIDCount") => cid_count = i64::from(self.read_int()),
                Some("CIDMapOffset") => cid_map_offset = i64::from(self.read_int()),
                Some("FDBytes") => fd_bytes = i64::from(self.read_int()),
                Some("GDBytes") => gd_bytes = i64::from(self.read_int()),
                Some("SubrMapOffset") => subr_map_offset = i64::from(self.read_int()),
                Some("SDBytes") => sd_bytes = i64::from(self.read_int()),
                Some("SubrCount") => subr_count = i64::from(self.read_int()),
                Some(other) => self.read_private_entry(other, &mut len_iv),
                None => {}
            }
        }
        if !found_start_data || cid_count <= 0 || cid_map_offset < 0 || !(0..=4).contains(&fd_bytes) || !(1..=4).contains(&gd_bytes) {
            return Ok(None);
        }
        let max_length = (self.stream.end() - self.stream.pos) as f64;
        if start_data_length > max_length {
            if !start_data_is_hex {
                start_data_length = max_length;
            } else if start_data_length > 2.0 * max_length {
                return Ok(None);
            }
        }
        let Some(binary) = self.read_start_data(start_data_length, start_data_is_hex) else {
            return Ok(None);
        };
        let binary_len = binary.len() as i64;
        let cid_entry_size = fd_bytes + gd_bytes;
        let read_uint = |offset: i64, byte_count: i64| -> i64 {
            let mut n: u32 = 0;
            for i in 0..byte_count {
                let b = usize::try_from(offset + i).ok().and_then(|p| binary.get(p)).copied().unwrap_or(0);
                n = (n << 8) | u32::from(b);
            }
            i64::from(n)
        };
        if cid_map_offset + (cid_count + 1) * cid_entry_size > binary_len
            || (subr_count > 0 && (subr_map_offset < 0 || !(1..=4).contains(&sd_bytes) || subr_map_offset + (subr_count + 1) * sd_bytes > binary_len))
        {
            return Ok(None);
        }
        if fd_bytes > 0 {
            for cid in 0..cid_count {
                if read_uint(cid_map_offset + cid * cid_entry_size, fd_bytes) != 0 {
                    return Ok(None);
                }
            }
        }
        let mut subrs: Vec<Vec<u8>> = Vec::new();
        if subr_count > 0 {
            let offsets: Vec<i64> = (0..=subr_count).map(|i| read_uint(subr_map_offset + i * sd_bytes, sd_bytes)).collect();
            for i in 0..subr_count as usize {
                let (start, end) = (offsets[i], offsets[i + 1]);
                if end > binary_len || end < start {
                    subrs.push(Vec::new());
                    continue;
                }
                subrs.push(read_char_strings(&binary[start as usize..end as usize], len_iv));
            }
        }
        let subr_map: BTreeMap<i32, Vec<u8>> = subrs.into_iter().enumerate().map(|(i, s)| (i as i32, s)).collect();
        let mut glyphs: Vec<Type1Glyph> = Vec::new();
        let mut prev_offset = read_uint(cid_map_offset + fd_bytes, gd_bytes);
        for cid in 0..cid_count {
            let next_offset = read_uint(cid_map_offset + (cid + 1) * cid_entry_size + fd_bytes, gd_bytes);
            let glyph_name = if cid == 0 { ".notdef".to_owned() } else { format!("cid{cid}") };
            if next_offset > prev_offset && next_offset <= binary_len {
                let encoded = read_char_strings(&binary[prev_offset as usize..next_offset as usize], len_iv);
                let mut charstring = CharString::default();
                // A runaway recursion here is the exception pdf.js throws, which fails the whole file.
                let error = charstring.convert(&encoded, &subr_map, 0)?;
                glyphs.push(Type1Glyph {
                    glyph_name: Some(glyph_name),
                    width: charstring.width,
                    lsb: charstring.lsb,
                    seac: charstring.seac.take(),
                    has_charstring: error || charstring.has_output,
                });
            } else {
                let (width, lsb) = glyphs.first().map_or((0.0, 0.0), |g| (or_zero(g.width), or_zero(g.lsb)));
                // `notDef?.charstring.slice() || [0x8b, 0x0e]`: a copy of glyph 0's charstring, empty when that is.
                let has_charstring = glyphs.first().is_none_or(|g| g.has_charstring);
                glyphs.push(Type1Glyph { glyph_name: Some(glyph_name), width, lsb, seac: None, has_charstring });
            }
            prev_offset = next_offset;
        }
        Ok(Some(glyphs))
    }

    /// `extractFontHeader`.
    fn extract_font_header(&mut self, properties: &mut Type1Properties) {
        while let Some(token) = self.get_token() {
            if token != "/" {
                continue;
            }
            match self.get_token().as_deref() {
                Some("FontMatrix") => properties.font_matrix = Some(self.read_number_array()),
                Some("Encoding") => {
                    let argument = self.get_token();
                    let encoding = match argument.as_deref() {
                        Some(a) if !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()) => {
                            let size = js_to_int32(js_parse_int(a));
                            let mut encoding: BTreeMap<u32, String> = BTreeMap::new();
                            self.get_token();
                            for _ in 0..size {
                                let mut token = self.get_token();
                                while token.as_deref() != Some("dup") && token.as_deref() != Some("def") {
                                    token = self.get_token();
                                    if token.is_none() {
                                        return;
                                    }
                                }
                                if token.as_deref() == Some("def") {
                                    break;
                                }
                                let index = self.read_int();
                                self.get_token();
                                let glyph = self.get_token();
                                if let (Ok(index), Some(glyph)) = (u32::try_from(index), glyph) {
                                    encoding.insert(index, glyph);
                                }
                                self.get_token();
                            }
                            Some(encoding)
                        }
                        Some(name) => {
                            get_encoding(name).map(|table| table.iter().enumerate().map(|(code, glyph)| (code as u32, (*glyph).to_owned())).collect())
                        }
                        None => None,
                    };
                    properties.built_in_encoding = encoding;
                }
                Some("FontBBox") => {
                    let bbox = self.read_number_array();
                    set_ascent_descent(properties, &bbox);
                }
                _ => {}
            }
        }
    }
}

/// `ascent = Math.max(bbox[3], bbox[1])`, `descent = Math.min(bbox[1], bbox[3])`, `ascentScaled = true`.
fn set_ascent_descent(properties: &mut Type1Properties, bbox: &[f64]) {
    let at = |i: usize| bbox.get(i).copied().unwrap_or(f64::NAN);
    let (a, b) = (at(3), at(1));
    properties.ascent = Some(if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) });
    properties.descent = Some(if a.is_nan() || b.is_nan() { f64::NAN } else { b.min(a) });
    properties.ascent_scaled = true;
}

/// `value || 0`.
fn or_zero(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() { 0.0 } else { value }
}

// ---- the file layout ----------------------------------------------------------------------------------------------

const EEXEC_SIGNATURE: [u8; 5] = [0x65, 0x65, 0x78, 0x65, 0x63];

/// `findBlock(streamBytes, signature, startIndex)`: `(found, length)`.
fn find_block(stream_bytes: &[u8], signature: &[u8], start_index: i64) -> (bool, i64) {
    let stream_bytes_length = stream_bytes.len() as i64;
    let signature_length = signature.len() as i64;
    let scan_length = stream_bytes_length - signature_length;
    let mut i = start_index;
    let mut found = false;
    while i < scan_length {
        let mut j = 0;
        while j < signature_length && usize::try_from(i + j).ok().and_then(|p| stream_bytes.get(p)).is_some_and(|&b| b == signature[j as usize]) {
            j += 1;
        }
        if j >= signature_length {
            i += j;
            while i < stream_bytes_length && is_white_space(i32::from(stream_bytes[i as usize])) {
                i += 1;
            }
            found = true;
            break;
        }
        i += 1;
    }
    (found, i)
}

/// `getHeaderBlock(stream, suggestedLength)`: the cleartext block as a stream.
fn get_header_block(stream: &mut Stream, suggested_length: Option<f64>) -> Stream {
    let stream_start_pos = stream.pos;
    let header_bytes = stream.get_bytes(suggested_length);
    let header_len = header_bytes.len() as f64;
    if suggested_length == Some(header_len) {
        let (found, length) = find_block(&header_bytes, &EEXEC_SIGNATURE, header_bytes.len() as i64 - 2 * EEXEC_SIGNATURE.len() as i64);
        if found && length == header_bytes.len() as i64 {
            return Stream::new(header_bytes);
        }
    }
    tracing::warn!("Invalid \"Length1\" property in Type1 font -- trying to recover.");
    stream.pos = stream_start_pos;
    const SCAN_BLOCK_LENGTH: usize = 2048;
    let mut actual_length: Option<i64> = None;
    loop {
        let scan_bytes = stream.peek_bytes(SCAN_BLOCK_LENGTH);
        let (found, length) = find_block(&scan_bytes, &EEXEC_SIGNATURE, 0);
        if length == 0 {
            break;
        }
        stream.pos += length;
        if found {
            actual_length = Some(stream.pos - stream_start_pos);
            break;
        }
    }
    stream.pos = stream_start_pos;
    if let Some(actual) = actual_length.filter(|&a| a != 0) {
        return Stream::new(stream.get_bytes(Some(actual as f64)));
    }
    tracing::warn!("Unable to recover \"Length1\" property in Type1 font -- using as is.");
    Stream::new(stream.get_bytes(suggested_length))
}

/// `getEexecBlock(stream, suggestedLength)`.
fn get_eexec_block(stream: &mut Stream) -> Result<Stream> {
    let eexec_bytes = stream.get_bytes(None);
    if eexec_bytes.is_empty() {
        return Err(PdfError::Format("getEexecBlock - no font program found.".to_owned()));
    }
    Ok(Stream::new(eexec_bytes))
}

/// `isCidKeyedType1File(file)`.
fn is_cid_keyed_type1_file(file: &Stream) -> bool {
    let from = file.pos.clamp(0, file.end()) as usize;
    let sample = &file.bytes[from..(from + 2048).min(file.bytes.len())];
    if sample.len() < 2 || sample[0] != 0x25 || sample[1] != 0x21 {
        return false;
    }
    let text: String = sample.iter().map(|&b| char::from(b)).collect();
    if text.contains("Resource-CIDFont") {
        return true;
    }
    // /\/CIDFontType\s+0\b/
    let mut from = 0;
    while let Some(found) = text[from..].find("/CIDFontType") {
        let mut at = from + found + "/CIDFontType".len();
        let spaces_from = at;
        let is_space = |c: char| matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}');
        while text[at..].chars().next().is_some_and(is_space) {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
        if at > spaces_from && text[at..].starts_with('0') {
            let next = text[at + 1..].chars().next();
            if !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                return true;
            }
        }
        from += found + 1;
    }
    false
}

/// `Type1Font.#parseType1`.
fn parse_type1(file: &mut Stream, properties: &mut Type1Properties) -> Result<Vec<Type1Glyph>> {
    const PFB_HEADER_SIZE: usize = 6;
    let mut header_block_length = properties.length1;
    let pfb_header = file.peek_bytes(PFB_HEADER_SIZE);
    let pfb_header_present = pfb_header.first() == Some(&0x80) && pfb_header.get(1) == Some(&0x01);
    let segment_length = |h: &[u8]| {
        let b = |i: usize| i32::from(h.get(i).copied().unwrap_or(0));
        f64::from((b(5) << 24) | (b(4) << 16) | (b(3) << 8) | b(2))
    };
    if pfb_header_present {
        file.skip(PFB_HEADER_SIZE as i64);
        header_block_length = Some(segment_length(&pfb_header));
    }
    let header_block = get_header_block(file, header_block_length);
    let mut header_parser = Type1Parser::new(header_block, false);
    header_parser.extract_font_header(properties);
    if pfb_header_present {
        file.get_bytes(Some(PFB_HEADER_SIZE as f64));
    }
    let eexec_block = get_eexec_block(file)?;
    let mut eexec_parser = Type1Parser::new(eexec_block, true);
    eexec_parser.extract_font_program(properties)
}

/// `Type1Font.#parseCidKeyedType1`.
fn parse_cid_keyed_type1(file: &Stream, properties: &mut Type1Properties) -> Result<Option<Vec<Type1Glyph>>> {
    // The parser reads its own copy of the stream, so a file it cannot read is still at its start for the plain
    // Type 1 reader (pdf.js resets `file.pos`).
    let stream = Stream { bytes: file.bytes.clone(), pos: file.pos };
    let mut parser = Type1Parser::new(stream, false);
    let data = parser.extract_cid_keyed_font_program(properties)?;
    if data.is_none() {
        tracing::warn!("Type1Font: unable to parse CID-keyed Type 1 font.");
    }
    Ok(data)
}
