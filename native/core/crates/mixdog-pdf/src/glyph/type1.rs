//! Type 1 font programs, following pdf.js `type1_parser.js` and `type1_font.js`: the PFB segments, eexec decryption,
//! the PostScript private dictionary scanner, and the conversion of every Type 1 charstring to Type 2 (flex, seac and
//! the other subroutines as pdf.js handles them; hints are dropped, `HINTING_ENABLED` is false there). The Type 2
//! charstrings are then drawn by [`super::type2`].
//!
//! pdf.js compiles the converted font to CFF bytes and reads them back; here the charstrings go straight to
//! [`Type2Font::from_charstrings`], which runs the same repair pass over them. The private dictionary values that
//! only feed the hinting entries of that CFF (`BlueValues`, `StdHW`, ...) are scanned past and not kept.

use super::type2::{Type2Font, js_parse_float};
use super::{Result, error};
use crate::stream::ByteStream;

const EEXEC_ENCRYPT_KEY: u32 = 55665;
const CHAR_STRS_ENCRYPT_KEY: u32 = 4330;
/// Deepest chain of `callsubr` the converter follows (pdf.js recurses until its stack overflows and fails the font).
const MAX_SUBR_DEPTH: usize = 1000;
/// Subroutine numbers above this are dropped (a sparse JS array of that size is cheap, a vector is not).
const MAX_SUBR_INDEX: usize = 1 << 20;

fn is_white_space(ch: i32) -> bool {
    ch == 0x20 || ch == 0x09 || ch == 0x0d || ch == 0x0a
}

fn is_hex_digit(code: i32) -> bool {
    (48..=57).contains(&code) || (65..=70).contains(&code) || (97..=102).contains(&code)
}

fn is_special(c: i32) -> bool {
    matches!(c, 0x2f | 0x5b | 0x5d | 0x7b | 0x7d | 0x28 | 0x29)
}

/// JS `ToInt32` of a number.
fn to_int32(v: f64) -> i32 {
    if !v.is_finite() {
        return 0;
    }
    (v.trunc().rem_euclid(4294967296.0) as i64) as u32 as i32
}

/// JS `parseInt(text, 10) | 0`.
fn parse_int(text: &str) -> i32 {
    let b = text.as_bytes();
    let (negative, digits) = match b.first() {
        Some(b'-') => (true, &b[1..]),
        Some(b'+') => (false, &b[1..]),
        _ => (false, b),
    };
    let count = digits.iter().take_while(|c| c.is_ascii_digit()).count();
    if count == 0 {
        return 0;
    }
    let mut value = 0f64;
    for &d in &digits[..count] {
        value = value * 10.0 + f64::from(d - b'0');
    }
    to_int32(if negative { -value } else { value })
}

/// pdf.js `decrypt` of a binary block: `discard` leading bytes are decrypted to advance the cipher and dropped.
fn decrypt(data: &[u8], key: u32, discard: f64) -> Vec<u8> {
    if discard.is_nan() || discard >= data.len() as f64 {
        return Vec::new();
    }
    let discard = discard.max(0.0) as usize;
    let (c1, c2) = (52845u64, 22719u64);
    let mut r = u64::from(key);
    for &b in &data[..discard] {
        r = ((u64::from(b) + r) * c1 + c2) & 0xffff;
    }
    let mut out = Vec::with_capacity(data.len() - discard);
    for &b in &data[discard..] {
        out.push(b ^ (r >> 8) as u8);
        r = ((u64::from(b) + r) * c1 + c2) & 0xffff;
    }
    out
}

/// pdf.js `decryptAscii`: the same over a hex-digit encoding of the block.
fn decrypt_ascii(data: &[u8], key: u32, discard: usize) -> Vec<u8> {
    let (c1, c2) = (52845u64, 22719u64);
    let mut r = u64::from(key);
    let count = data.len();
    let mut out: Vec<u8> = Vec::with_capacity(count >> 1);
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let mut i = 0;
    while i < count {
        let digit1 = data[i];
        if !is_hex_digit(i32::from(digit1)) {
            i += 1;
            continue;
        }
        i += 1;
        while i < count && !is_hex_digit(i32::from(data[i])) {
            i += 1;
        }
        if i < count {
            let value = hex(digit1).unwrap_or(0) * 16 + hex(data[i]).unwrap_or(0);
            out.push(value ^ (r >> 8) as u8);
            r = ((u64::from(value) + r) * c1 + c2) & 0xffff;
        }
        i += 1;
    }
    let from = discard.min(out.len());
    out[from..].to_vec()
}

/// `Stream.getBytes(length)`: up to `length` bytes (all the rest when `length` is 0 or missing), moving the position.
fn get_bytes(stream: &mut ByteStream, length: Option<usize>) -> Vec<u8> {
    let pos = stream.pos;
    let end_pos = match length {
        Some(l) if l > 0 => pos.saturating_add(l).min(stream.end),
        _ => stream.end,
    };
    stream.pos = end_pos;
    super::truetype::subarray(stream.data(), pos, end_pos).to_vec()
}

// ---------------------------------------------------------------------------------------------------------------------
// Charstrings

#[derive(Debug, Default)]
struct Type1CharString {
    width: f64,
    lsb: f64,
    flexing: bool,
    output: Vec<u8>,
    stack: Vec<f64>,
    seac: Option<Vec<f64>>,
}

impl Type1CharString {
    fn num(&self, from_top: usize) -> f64 {
        self.stack.len().checked_sub(from_top).map_or(f64::NAN, |i| self.stack[i])
    }

    /// pdf.js `Type1CharString.convert`: `true` when the charstring is malformed.
    fn convert(&mut self, encoded: &[u8], subrs: &[Option<Vec<u8>>], depth: usize) -> bool {
        if depth > MAX_SUBR_DEPTH {
            return true;
        }
        let count = encoded.len();
        let mut error = false;
        let mut i = 0usize;
        while i < count {
            let mut value = i32::from(encoded[i]);
            if value < 32 {
                if value == 12 {
                    i += 1;
                    value = (12 << 8) + i32::from(encoded.get(i).copied().unwrap_or(0));
                }
                match value {
                    1 | 3 => self.stack.clear(),
                    4 => {
                        if self.flexing {
                            match self.stack.pop() {
                                None => error = true,
                                Some(dy) => {
                                    self.stack.push(0.0);
                                    self.stack.push(dy);
                                }
                            }
                        } else {
                            error = self.execute(1, &[4], false);
                        }
                    }
                    5 => error = self.execute(2, &[5], false),
                    6 => error = self.execute(1, &[6], false),
                    7 => error = self.execute(1, &[7], false),
                    8 => error = self.execute(6, &[8], false),
                    9 => self.stack.clear(),
                    10 => match self.stack.pop() {
                        None => error = true,
                        Some(n) => {
                            let subr = if n.is_finite() && n >= 0.0 && n.fract() == 0.0 { subrs.get(n as usize).and_then(Option::as_ref) } else { None };
                            match subr {
                                None => error = true,
                                Some(code) => error = self.convert(code, subrs, depth + 1),
                            }
                        }
                    },
                    11 => return error,
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
                            error = self.execute(2, &[22], false);
                        }
                    }
                    14 => self.output.push(14),
                    21 => {
                        if !self.flexing {
                            error = self.execute(2, &[21], false);
                        }
                    }
                    22 => {
                        if self.flexing {
                            self.stack.push(0.0);
                        } else {
                            error = self.execute(1, &[22], false);
                        }
                    }
                    30 => error = self.execute(4, &[30], false),
                    31 => error = self.execute(4, &[31], false),
                    v if v == (12 << 8) => self.stack.clear(),
                    v if v == (12 << 8) + 1 || v == (12 << 8) + 2 => self.stack.clear(),
                    v if v == (12 << 8) + 6 => {
                        // seac with analysis on: the four arguments are kept for the font object, the glyph ends
                        let asb = self.num(5);
                        let split = self.stack.len().saturating_sub(4);
                        let mut seac = self.stack.split_off(split);
                        match seac.first_mut() {
                            Some(first) => *first += self.lsb - asb,
                            None => seac.push(f64::NAN),
                        }
                        self.seac = Some(seac);
                        error = self.execute(0, &[14], false);
                    }
                    v if v == (12 << 8) + 7 => {
                        if self.stack.len() < 4 {
                            error = true;
                        } else {
                            self.stack.pop();
                            let wx = self.stack.pop().unwrap_or(f64::NAN);
                            let sby = self.stack.pop().unwrap_or(f64::NAN);
                            let sbx = self.stack.pop().unwrap_or(f64::NAN);
                            self.lsb = sbx;
                            self.width = wx;
                            self.stack.extend_from_slice(&[wx, sbx, sby]);
                            error = self.execute(3, &[21], false);
                        }
                    }
                    v if v == (12 << 8) + 12 => {
                        if self.stack.len() < 2 {
                            error = true;
                        } else {
                            let num2 = self.stack.pop().unwrap_or(f64::NAN);
                            let num1 = self.stack.pop().unwrap_or(f64::NAN);
                            self.stack.push(num1 / num2);
                        }
                    }
                    v if v == (12 << 8) + 16 => {
                        if self.stack.len() < 2 {
                            error = true;
                        } else {
                            let subr_number = self.stack.pop().unwrap_or(f64::NAN);
                            let num_args = self.stack.pop().unwrap_or(f64::NAN);
                            if subr_number == 0.0 && num_args == 3.0 {
                                let split = self.stack.len().saturating_sub(17);
                                let flex = self.stack.split_off(split);
                                let at = |k: usize| flex.get(k).copied().unwrap_or(f64::NAN);
                                self.stack.extend_from_slice(&[
                                    at(2) + at(0),
                                    at(3) + at(1),
                                    at(4),
                                    at(5),
                                    at(6),
                                    at(7),
                                    at(8),
                                    at(9),
                                    at(10),
                                    at(11),
                                    at(12),
                                    at(13),
                                    at(14),
                                ]);
                                error = self.execute(13, &[12, 35], true);
                                self.flexing = false;
                                self.stack.push(at(15));
                                self.stack.push(at(16));
                            } else if subr_number == 1.0 && num_args == 0.0 {
                                self.flexing = true;
                            }
                        }
                    }
                    v if v == (12 << 8) + 17 => {}
                    v if v == (12 << 8) + 33 => self.stack.clear(),
                    v => tracing::warn!("Unknown type 1 charstring command of \"{v}\""),
                }
                if error {
                    break;
                }
                i += 1;
                continue;
            } else if value <= 246 {
                value -= 139;
            } else if value <= 250 {
                i += 1;
                value = (value - 247) * 256 + i32::from(encoded.get(i).copied().unwrap_or(0)) + 108;
            } else if value <= 254 {
                i += 1;
                value = -((value - 251) * 256) - i32::from(encoded.get(i).copied().unwrap_or(0)) - 108;
            } else {
                let mut word = 0i32;
                for _ in 0..4 {
                    i += 1;
                    word = (word << 8) | i32::from(encoded.get(i).copied().unwrap_or(0));
                }
                value = word;
            }
            self.stack.push(f64::from(value));
            i += 1;
        }
        error
    }

    /// pdf.js `executeCommand`: writes the top `how_many` stack values as Type 2 numbers, then the operator.
    fn execute(&mut self, how_many: usize, command: &[u8], keep_stack: bool) -> bool {
        let len = self.stack.len();
        if how_many > len {
            return true;
        }
        let start = len - how_many;
        for k in start..len {
            let value = self.stack[k];
            if value.fract() == 0.0 && value.is_finite() {
                let v = to_int32(value);
                self.output.extend_from_slice(&[28, (v >> 8) as u8, v as u8]);
            } else {
                let v = to_int32(65536.0 * value);
                self.output.extend_from_slice(&[255, (v >> 24) as u8, (v >> 16) as u8, (v >> 8) as u8, v as u8]);
            }
        }
        self.output.extend_from_slice(command);
        if keep_stack {
            self.stack.drain(start..start + how_many);
        } else {
            self.stack.clear();
        }
        false
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The PostScript scanner

/// A glyph of a Type 1 program, its charstring already converted to Type 2.
#[derive(Debug, Clone)]
pub struct Type1Glyph {
    pub glyph_name: String,
    pub charstring: Vec<u8>,
    pub width: f64,
    pub lsb: f64,
    /// The four arguments of a seac glyph (adx, ady, bchar, achar) with the left side bearing correction applied.
    pub seac: Option<Vec<f64>>,
}

/// The font's own `/Encoding`: a named one (`StandardEncoding`, ...) for the caller to resolve, or the explicit
/// `dup <code> /<name> put` list.
#[derive(Debug, Clone, PartialEq)]
pub enum BuiltInEncoding {
    Named(String),
    Explicit(Vec<(usize, String)>),
}

struct Program {
    subrs: Vec<Option<Vec<u8>>>,
    glyphs: Vec<Type1Glyph>,
}

#[derive(Default)]
struct Properties {
    font_matrix: Option<Vec<f64>>,
    built_in_encoding: Option<BuiltInEncoding>,
    font_bbox: Option<Vec<f64>>,
}

struct Parser {
    stream: ByteStream,
    current: i32,
}

impl Parser {
    fn new(stream: ByteStream, encrypted: bool) -> Self {
        let mut stream = stream;
        if encrypted {
            let data = get_bytes(&mut stream, None);
            let at = |k: usize| data.get(k).map_or(-1, |&b| i32::from(b));
            let is_binary = !((is_hex_digit(at(0)) || is_white_space(at(0))) && (1..=7).all(|k| is_hex_digit(at(k))));
            let plain = if is_binary { decrypt(&data, EEXEC_ENCRYPT_KEY, 4.0) } else { decrypt_ascii(&data, EEXEC_ENCRYPT_KEY, 4) };
            stream = ByteStream::from_vec(plain);
        }
        let mut parser = Parser { stream, current: -1 };
        parser.next_char();
        parser
    }

    fn next_char(&mut self) -> i32 {
        self.current = self.stream.get_byte();
        self.current
    }

    fn prev_char(&mut self) -> i32 {
        self.stream.skip(-2);
        self.current = self.stream.get_byte();
        self.current
    }

    fn get_token(&mut self) -> Option<String> {
        let mut comment = false;
        let mut ch = self.current;
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

    fn read_number_array(&mut self) -> Vec<f64> {
        self.get_token();
        let mut array = Vec::new();
        loop {
            match self.get_token() {
                None => break,
                Some(t) if t == "]" || t == "}" => break,
                Some(t) => array.push(js_parse_float(&t)),
            }
        }
        array
    }

    fn read_number(&mut self) -> f64 {
        self.get_token().map_or(0.0, |t| js_parse_float(&t))
    }

    fn read_int(&mut self) -> i32 {
        self.get_token().map_or(0, |t| parse_int(&t))
    }

    fn read_boolean(&mut self) -> bool {
        self.get_token().as_deref() == Some("true")
    }

    fn read_char_strings(bytes: &[u8], len_iv: f64) -> Vec<u8> {
        if len_iv == -1.0 {
            return bytes.to_vec();
        }
        decrypt(bytes, CHAR_STRS_ENCRYPT_KEY, len_iv)
    }

    /// pdf.js `extractFontProgram`: the Subrs and CharStrings of the decrypted private part.
    fn extract_font_program(&mut self) -> Program {
        let mut subrs: Vec<Option<Vec<u8>>> = Vec::new();
        let mut charstrings: Vec<(String, Vec<u8>)> = Vec::new();
        let mut len_iv = 4.0f64;
        let (mut subrs_parsed, mut char_strings_parsed) = (false, false);
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
                        if token.is_none() || token.as_deref() == Some("end") {
                            break;
                        }
                        if token.as_deref() != Some("/") {
                            continue;
                        }
                        let glyph = self.get_token().unwrap_or_default();
                        let length = self.read_int();
                        self.get_token();
                        let data = if length > 0 { get_bytes(&mut self.stream, Some(length as usize)) } else { Vec::new() };
                        let encoded = Self::read_char_strings(&data, len_iv);
                        self.next_char();
                        let token = self.get_token();
                        if token.as_deref() == Some("noaccess") {
                            self.get_token();
                        } else if token.as_deref() == Some("/") {
                            self.prev_char();
                        }
                        charstrings.push((glyph, encoded));
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
                        let data = if length > 0 { get_bytes(&mut self.stream, Some(length as usize)) } else { Vec::new() };
                        let encoded = Self::read_char_strings(&data, len_iv);
                        self.next_char();
                        if self.get_token().as_deref() == Some("noaccess") {
                            self.get_token();
                        }
                        if let Ok(index) = usize::try_from(index) {
                            if index <= MAX_SUBR_INDEX {
                                if subrs.len() <= index {
                                    subrs.resize(index + 1, None);
                                }
                                subrs[index] = Some(encoded);
                            }
                        }
                    }
                }
                "BlueValues" | "OtherBlues" | "FamilyBlues" | "FamilyOtherBlues" | "StemSnapH" | "StemSnapV" | "StdHW" | "StdVW" => {
                    self.read_number_array();
                }
                "lenIV" => len_iv = self.read_number(),
                "BlueShift" | "BlueFuzz" | "BlueScale" | "LanguageGroup" | "ExpansionFactor" => {
                    self.read_number();
                }
                "ForceBold" => {
                    self.read_boolean();
                }
                _ => {}
            }
        }
        convert_glyphs(charstrings, subrs)
    }

    /// pdf.js `extractCidKeyedFontProgram`: a CID-keyed Type 1 file (`StartData` with a CIDMap). `None` when the file
    /// is not one the converter can read.
    fn extract_cid_keyed_font_program(&mut self, properties: &mut Properties) -> Option<Program> {
        let mut len_iv = 4.0f64;
        let (mut cid_count, mut cid_map_offset, mut fd_bytes, mut gd_bytes) = (0i32, -1i32, 1i32, 0i32);
        let (mut subr_map_offset, mut sd_bytes, mut subr_count) = (-1i32, 0i32, 0i32);
        let (mut start_data_length, mut start_data_is_hex, mut found_start_data) = (0usize, false, false);
        let mut previous: Vec<Option<String>> = Vec::new();
        let remember = |previous: &mut Vec<Option<String>>, value: Option<String>| {
            previous.push(value);
            if previous.len() > 4 {
                previous.remove(0);
            }
        };
        while let Some(token) = self.get_token() {
            if token == "StartData" {
                let at = |k: usize| previous.len().checked_sub(k).and_then(|i| previous[i].as_deref());
                let data_type = at(3);
                let data_length = at(1);
                let digits = data_length.is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
                if at(4) != Some("(") || at(2) != Some(")") || !matches!(data_type, Some("Binary") | Some("Hex")) || !digits {
                    return None;
                }
                start_data_length = data_length.and_then(|d| d.parse::<usize>().ok()).unwrap_or(usize::MAX);
                if start_data_length == 0 {
                    return None;
                }
                start_data_is_hex = data_type == Some("Hex");
                found_start_data = true;
                break;
            }
            remember(&mut previous, Some(token.clone()));
            if token != "/" {
                continue;
            }
            let name = self.get_token();
            remember(&mut previous, name.clone());
            match name.as_deref() {
                Some("FontMatrix") => properties.font_matrix = Some(self.read_number_array()),
                Some("FontBBox") => properties.font_bbox = Some(self.read_number_array()),
                Some("CIDCount") => cid_count = self.read_int(),
                Some("CIDMapOffset") => cid_map_offset = self.read_int(),
                Some("FDBytes") => fd_bytes = self.read_int(),
                Some("GDBytes") => gd_bytes = self.read_int(),
                Some("SubrMapOffset") => subr_map_offset = self.read_int(),
                Some("SDBytes") => sd_bytes = self.read_int(),
                Some("SubrCount") => subr_count = self.read_int(),
                Some("BlueValues" | "OtherBlues" | "FamilyBlues" | "FamilyOtherBlues" | "StemSnapH" | "StemSnapV" | "StdHW" | "StdVW") => {
                    self.read_number_array();
                }
                Some("lenIV") => len_iv = self.read_number(),
                Some("BlueShift" | "BlueFuzz" | "BlueScale" | "LanguageGroup" | "ExpansionFactor") => {
                    self.read_number();
                }
                Some("ForceBold") => {
                    self.read_boolean();
                }
                _ => {}
            }
        }
        if !found_start_data || cid_count <= 0 || cid_map_offset < 0 || !(0..=4).contains(&fd_bytes) || !(1..=4).contains(&gd_bytes) {
            return None;
        }
        let max_length = self.stream.end.saturating_sub(self.stream.pos);
        if start_data_length > max_length {
            if !start_data_is_hex {
                start_data_length = max_length;
            } else if start_data_length > 2 * max_length {
                return None;
            }
        }
        let mut binary = get_bytes(&mut self.stream, if start_data_is_hex { None } else { Some(start_data_length) });
        if start_data_is_hex {
            let mut decoded = vec![0u8; start_data_length];
            let (mut digit1, mut j) = (-1i32, 0usize);
            for &digit in &binary {
                if j >= start_data_length {
                    break;
                }
                if !is_hex_digit(i32::from(digit)) {
                    continue;
                }
                if digit1 < 0 {
                    digit1 = i32::from(digit);
                    continue;
                }
                let value = (digit1 as u8 as char).to_digit(16).unwrap_or(0) * 16 + (digit as char).to_digit(16).unwrap_or(0);
                decoded[j] = value as u8;
                j += 1;
                digit1 = -1;
            }
            if j != start_data_length {
                return None;
            }
            binary = decoded;
        }
        let (cid_count, cid_map_offset, fd_bytes, gd_bytes) = (cid_count as usize, cid_map_offset as usize, fd_bytes as usize, gd_bytes as usize);
        let cid_entry_size = fd_bytes + gd_bytes;
        let read_uint = |offset: usize, byte_count: usize| -> u32 {
            let mut n = 0u32;
            for i in 0..byte_count {
                n = (n << 8) | u32::from(binary.get(offset + i).copied().unwrap_or(0));
            }
            n
        };
        let subr_count = subr_count.max(0) as usize;
        let (subr_map_offset_u, sd_bytes_u) = (subr_map_offset.max(0) as usize, sd_bytes.max(0) as usize);
        if cid_map_offset + (cid_count + 1) * cid_entry_size > binary.len()
            || (subr_count > 0 && (subr_map_offset < 0 || !(1..=4).contains(&sd_bytes) || subr_map_offset_u + (subr_count + 1) * sd_bytes_u > binary.len()))
        {
            return None;
        }
        if fd_bytes > 0 && (0..cid_count).any(|cid| read_uint(cid_map_offset + cid * cid_entry_size, fd_bytes) != 0) {
            return None;
        }
        let mut subrs: Vec<Option<Vec<u8>>> = Vec::new();
        if subr_count > 0 {
            let offsets: Vec<usize> = (0..=subr_count).map(|i| read_uint(subr_map_offset_u + i * sd_bytes_u, sd_bytes_u) as usize).collect();
            for i in 0..subr_count {
                let (start, end) = (offsets[i], offsets[i + 1]);
                if end > binary.len() || end < start {
                    subrs.push(Some(Vec::new()));
                    continue;
                }
                subrs.push(Some(Self::read_char_strings(&binary[start..end], len_iv)));
            }
        }
        let mut glyphs: Vec<Type1Glyph> = Vec::new();
        let mut prev_offset = read_uint(cid_map_offset + fd_bytes, gd_bytes) as usize;
        for cid in 0..cid_count {
            let next_offset = read_uint(cid_map_offset + (cid + 1) * cid_entry_size + fd_bytes, gd_bytes) as usize;
            let glyph_name = if cid == 0 { ".notdef".to_string() } else { format!("cid{cid}") };
            if next_offset > prev_offset && next_offset <= binary.len() {
                let encoded = Self::read_char_strings(&binary[prev_offset..next_offset], len_iv);
                let mut cs = Type1CharString::default();
                let failed = cs.convert(&encoded, &subrs, 0);
                glyphs.push(Type1Glyph { glyph_name, charstring: if failed { vec![14] } else { cs.output }, width: cs.width, lsb: cs.lsb, seac: cs.seac });
            } else {
                let not_def = glyphs.first();
                glyphs.push(Type1Glyph {
                    glyph_name,
                    charstring: not_def.map_or_else(|| vec![0x8b, 0x0e], |g| g.charstring.clone()),
                    width: not_def.map_or(0.0, |g| g.width),
                    lsb: not_def.map_or(0.0, |g| g.lsb),
                    seac: None,
                });
            }
            prev_offset = next_offset;
        }
        Some(Program { subrs, glyphs })
    }

    /// pdf.js `extractFontHeader`: the `FontMatrix`, `Encoding` and `FontBBox` of the clear-text header.
    fn extract_font_header(&mut self, properties: &mut Properties) {
        while let Some(token) = self.get_token() {
            if token != "/" {
                continue;
            }
            match self.get_token().as_deref() {
                Some("FontMatrix") => properties.font_matrix = Some(self.read_number_array()),
                Some("Encoding") => {
                    let arg = self.get_token().unwrap_or_default();
                    if arg.is_empty() || !arg.bytes().all(|b| b.is_ascii_digit()) {
                        properties.built_in_encoding = Some(BuiltInEncoding::Named(arg));
                    } else {
                        let mut encoding: Vec<(usize, String)> = Vec::new();
                        let size = parse_int(&arg);
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
                            let glyph = self.get_token().unwrap_or_default();
                            if let Ok(index) = usize::try_from(index) {
                                encoding.push((index, glyph));
                            }
                            self.get_token();
                        }
                        properties.built_in_encoding = Some(BuiltInEncoding::Explicit(encoding));
                    }
                }
                Some("FontBBox") => properties.font_bbox = Some(self.read_number_array()),
                _ => {}
            }
        }
    }
}

/// Converts every charstring of a scanned private part; `.notdef` is put first.
fn convert_glyphs(charstrings: Vec<(String, Vec<u8>)>, subrs: Vec<Option<Vec<u8>>>) -> Program {
    let mut glyphs: Vec<Type1Glyph> = Vec::new();
    for (glyph_name, encoded) in charstrings {
        let mut cs = Type1CharString::default();
        let failed = cs.convert(&encoded, &subrs, 0);
        let glyph = Type1Glyph { glyph_name, charstring: if failed { vec![14] } else { cs.output }, width: cs.width, lsb: cs.lsb, seac: cs.seac };
        if glyph.glyph_name == ".notdef" {
            glyphs.insert(0, glyph);
        } else {
            glyphs.push(glyph);
        }
    }
    Program { subrs, glyphs }
}

// ---------------------------------------------------------------------------------------------------------------------
// The font file

const EEXEC_SIGNATURE: &[u8; 5] = b"eexec";

/// pdf.js `findBlock`: where `signature` ends (and the whitespace after it), or where the scan stopped.
fn find_block(bytes: &[u8], signature: &[u8], start_index: i64) -> (bool, i64) {
    let len = bytes.len() as i64;
    let sig_len = signature.len() as i64;
    let scan_length = len - sig_len;
    let mut i = start_index;
    let mut found = false;
    while i < scan_length {
        let mut j = 0i64;
        while j < sig_len && usize::try_from(i + j).ok().and_then(|k| bytes.get(k)) == Some(&signature[j as usize]) {
            j += 1;
        }
        if j >= sig_len {
            i += j;
            while i < len && is_white_space(i32::from(bytes[i as usize])) {
                i += 1;
            }
            found = true;
            break;
        }
        i += 1;
    }
    (found, i)
}

/// pdf.js `getHeaderBlock`: the clear-text part up to and including `eexec`. `suggested` is `Length1`.
fn get_header_block(stream: &mut ByteStream, suggested: Option<i64>) -> Vec<u8> {
    let start = stream.pos;
    let length_arg = suggested.filter(|&l| l > 0).map(|l| l as usize);
    let header = get_bytes(stream, length_arg);
    if suggested == Some(header.len() as i64) {
        let (found, length) = find_block(&header, EEXEC_SIGNATURE, header.len() as i64 - 2 * EEXEC_SIGNATURE.len() as i64);
        if found && length == header.len() as i64 {
            return header;
        }
    }
    tracing::warn!("Invalid \"Length1\" property in Type1 font -- trying to recover.");
    stream.pos = start;
    let mut actual: Option<usize> = None;
    loop {
        let scan = stream.peek_bytes(2048).to_vec();
        let (found, length) = find_block(&scan, EEXEC_SIGNATURE, 0);
        if length == 0 {
            break;
        }
        stream.pos += length as usize;
        if found {
            actual = Some(stream.pos - start);
            break;
        }
    }
    stream.pos = start;
    if let Some(actual) = actual.filter(|&a| a > 0) {
        return get_bytes(stream, Some(actual));
    }
    tracing::warn!("Unable to recover \"Length1\" property in Type1 font -- using as is.");
    get_bytes(stream, length_arg)
}

fn is_js_space(b: u8) -> bool {
    matches!(b, 9..=13 | 32 | 0xa0)
}

/// pdf.js `isCidKeyedType1File`: a `%!` file whose first 2048 bytes name a CID font resource or `/CIDFontType 0`.
fn is_cid_keyed_type1_file(file: &ByteStream) -> bool {
    let sample = file.peek_bytes(2048);
    if sample.len() < 2 || sample[0] != 0x25 || sample[1] != 0x21 {
        return false;
    }
    if sample.windows(16).any(|w| w == b"Resource-CIDFont") {
        return true;
    }
    let key = b"/CIDFontType";
    let mut from = 0;
    while let Some(at) = sample[from..].windows(key.len()).position(|w| w == key) {
        let mut k = from + at + key.len();
        let spaces = sample[k..].iter().take_while(|&&b| is_js_space(b)).count();
        k += spaces;
        if spaces > 0 && sample.get(k) == Some(&b'0') && !sample.get(k + 1).is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_') {
            return true;
        }
        from += at + 1;
    }
    false
}

/// A Type 1 font program read and converted: the glyphs in pdf.js's order (`.notdef` first when the font has one;
/// glyph id `n + 1` is `glyphs[n]`, id 0 the empty `.notdef` the CFF wrapper adds).
#[derive(Debug)]
pub struct Type1Font {
    pub glyphs: Vec<Type1Glyph>,
    /// The local subroutines in Type 2 numbering: `bias` empty returns first.
    pub subrs: Vec<Vec<u8>>,
    pub font_matrix: Option<Vec<f64>>,
    pub built_in_encoding: Option<BuiltInEncoding>,
    pub font_bbox: Option<Vec<f64>>,
}

/// What the font dictionary says of the file.
#[derive(Debug, Clone, Copy, Default)]
pub struct Type1Options {
    pub length1: Option<i64>,
    pub composite: bool,
}

impl Type1Font {
    /// pdf.js `new Type1Font(name, file, properties)`: reads the PFB (or bare) file.
    pub fn parse(file: &[u8], options: Type1Options) -> Result<Self> {
        let mut stream = ByteStream::from_vec(file.to_vec());
        let mut properties = Properties::default();
        let mut program = None;
        if options.composite && is_cid_keyed_type1_file(&stream) {
            let start = stream.pos;
            let mut parser = Parser::new(ByteStream::from_vec(get_bytes(&mut stream, None)), false);
            program = parser.extract_cid_keyed_font_program(&mut properties);
            if program.is_none() {
                tracing::warn!("Type1Font: unable to parse CID-keyed Type 1 font.");
                stream.pos = start;
            }
        }
        let program = match program {
            Some(p) => p,
            None => Self::parse_type1(&mut stream, options, &mut properties)?,
        };
        Ok(Self::finish(program, properties))
    }

    fn parse_type1(file: &mut ByteStream, options: Type1Options, properties: &mut Properties) -> Result<Program> {
        let mut header_block_length = options.length1;
        let pfb = file.peek_bytes(6).to_vec();
        let pfb_present = pfb.first() == Some(&0x80) && pfb.get(1) == Some(&0x01);
        let segment_length = |h: &[u8]| i64::from(i32::from_le_bytes([h[2], h[3], h[4], h[5]]));
        if pfb_present && pfb.len() == 6 {
            file.skip(6);
            header_block_length = Some(segment_length(&pfb));
        }
        let header = get_header_block(file, header_block_length);
        Parser::new(ByteStream::from_vec(header), false).extract_font_header(properties);
        if pfb_present {
            get_bytes(file, Some(6));
        }
        let eexec = get_bytes(file, None);
        if eexec.is_empty() {
            return error("getEexecBlock - no font program found.");
        }
        Ok(Parser::new(ByteStream::from_vec(eexec), true).extract_font_program())
    }

    fn finish(program: Program, properties: Properties) -> Self {
        let count = program.subrs.len();
        let bias = if count < 1133 {
            107
        } else if count < 33769 {
            1131
        } else {
            32768
        };
        let mut subrs: Vec<Vec<u8>> = vec![vec![0x0b]; bias];
        subrs.extend(program.subrs.into_iter().map(Option::unwrap_or_default));
        Self {
            glyphs: program.glyphs,
            subrs,
            font_matrix: properties.font_matrix,
            built_in_encoding: properties.built_in_encoding,
            font_bbox: properties.font_bbox,
        }
    }

    /// `[".notdef", ...glyph names]`: the charset in glyph id order.
    pub fn charset(&self) -> Vec<&str> {
        std::iter::once(".notdef").chain(self.glyphs.iter().map(|g| g.glyph_name.as_str())).collect()
    }

    /// pdf.js `numGlyphs`.
    pub fn num_glyphs(&self) -> usize {
        self.glyphs.len() + 1
    }

    /// pdf.js `hasGlyphId`.
    pub fn has_glyph_id(&self, id: usize) -> bool {
        match id {
            0 => true,
            n if n < self.num_glyphs() => !self.glyphs[n - 1].charstring.is_empty(),
            _ => false,
        }
    }

    /// pdf.js `getSeacs`: glyph id to the four seac arguments.
    pub fn seacs(&self) -> Vec<(usize, &[f64])> {
        self.glyphs.iter().enumerate().filter_map(|(i, g)| g.seac.as_deref().map(|s| (i + 1, s))).collect()
    }

    /// The Type 2 program pdf.js reads back from the CFF it compiles of this font.
    pub fn to_type2(&self) -> Type2Font {
        Type2Font::from_charstrings(self.glyphs.iter().map(|g| g.charstring.clone()).collect(), self.subrs.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt(plain: &[u8], key: u32, lead: &[u8]) -> Vec<u8> {
        let (c1, c2) = (52845u32, 22719u32);
        let mut r = key;
        let mut out = Vec::new();
        for &p in lead.iter().chain(plain) {
            let c = p ^ (r >> 8) as u8;
            r = ((u32::from(c) + r) * c1 + c2) & 0xffff;
            out.push(c);
        }
        out
    }

    #[test]
    fn decrypt_undoes_the_type_1_cipher_and_drops_the_lead_bytes() {
        let cipher = encrypt(b"hello type 1", EEXEC_ENCRYPT_KEY, &[1, 2, 3, 4]);
        assert_eq!(decrypt(&cipher, EEXEC_ENCRYPT_KEY, 4.0), b"hello type 1");
        let hex: String = cipher.iter().map(|b| format!("{b:02X} ")).collect();
        assert_eq!(decrypt_ascii(hex.as_bytes(), EEXEC_ENCRYPT_KEY, 4), b"hello type 1");
    }

    #[test]
    fn hsbw_rlineto_closepath_endchar_convert_to_type_2() {
        // 50 600 hsbw ; 100 0 rlineto ; closepath ; endchar
        let enc = [189u8, 248, 236, 13, 239, 139, 5, 9, 14];
        let mut cs = Type1CharString::default();
        assert!(!cs.convert(&enc, &[], 0));
        assert_eq!(cs.width, 600.0);
        assert_eq!(cs.lsb, 50.0);
        // hsbw -> "600 50 hmoveto" as 16-bit numbers and the hmoveto operator; the line as two numbers and rlineto
        assert_eq!(cs.output, vec![28, 2, 88, 28, 0, 50, 22, 28, 0, 100, 28, 0, 0, 5, 14]);
    }

    #[test]
    fn a_callsubr_to_a_missing_subroutine_is_an_error() {
        let mut cs = Type1CharString::default();
        assert!(cs.convert(&[140, 10], &[None, None], 0));
    }

    #[test]
    fn flex_through_othersubrs_becomes_one_flex_operator() {
        let mut cs = Type1CharString::default();
        // 17 flex arguments, then numArgs 3 and the othersubr number 0
        cs.stack = (0..17).map(f64::from).collect();
        cs.stack.extend([3.0, 0.0]);
        let enc = [12u8, 16];
        assert!(!cs.convert(&enc, &[], 0));
        assert_eq!(&cs.output[cs.output.len() - 2..], &[12, 35]);
        // the closing point is left for setcurrentpoint
        assert_eq!(cs.stack, vec![15.0, 16.0]);
    }

    #[test]
    fn a_cid_keyed_file_is_told_by_its_resource_name() {
        let file = ByteStream::from_vec(b"%!PS-Adobe-3.0 Resource-CIDFont\n".to_vec());
        assert!(is_cid_keyed_type1_file(&file));
        let plain = ByteStream::from_vec(b"%!PS-AdobeFont-1.0\n/CIDFontType 0 def".to_vec());
        assert!(is_cid_keyed_type1_file(&plain));
        let other = ByteStream::from_vec(b"%!PS-AdobeFont-1.0\n/CIDFontType 02 def".to_vec());
        assert!(!is_cid_keyed_type1_file(&other));
    }

    #[test]
    fn find_block_reports_the_end_of_eexec_and_the_whitespace_after_it() {
        let bytes = b"abc currentfile eexec \r\nXYZ";
        let (found, end) = find_block(bytes, EEXEC_SIGNATURE, 0);
        assert!(found);
        assert_eq!(&bytes[end as usize..], b"XYZ");
    }

    /// A Type 1 charstring (lenIV 4) of plain bytes.
    fn charstring(plain: &[u8]) -> Vec<u8> {
        encrypt(plain, CHAR_STRS_ENCRYPT_KEY, &[7, 7, 7, 7])
    }

    /// A small font in the binary (eexec) form: glyphs `.notdef` and `A`, one subroutine, an explicit encoding.
    fn small_font() -> Vec<u8> {
        let notdef = charstring(&[189, 248, 236, 13, 14]); // 50 600 hsbw endchar
        // 50 600 hsbw, 100 100 rmoveto, 100 0 rlineto, 0 100 rlineto, closepath, endchar
        let a = charstring(&[189, 248, 236, 13, 239, 239, 21, 239, 139, 5, 139, 239, 5, 9, 14]);
        let subr = charstring(&[11]);
        let mut private = Vec::new();
        private.extend_from_slice(
            b"dup /Private 8 dict dup begin /RD {string currentfile exch readstring pop} executeonly def
/lenIV 4 def
/Subrs 1 array
dup 0 ",
        );
        private.extend_from_slice(format!("{} RD ", subr.len()).as_bytes());
        private.extend_from_slice(&subr);
        private.extend_from_slice(
            b" NP
ND
2 index /CharStrings 2 dict dup begin
/.notdef ",
        );
        private.extend_from_slice(format!("{} RD ", notdef.len()).as_bytes());
        private.extend_from_slice(&notdef);
        private.extend_from_slice(
            b" ND
/A ",
        );
        private.extend_from_slice(format!("{} RD ", a.len()).as_bytes());
        private.extend_from_slice(&a);
        private.extend_from_slice(
            b" ND
end end
",
        );
        let mut file = b"%!PS-AdobeFont-1.0: Small 1.0
/FontMatrix [0.001 0 0 0.001 0 0] readonly def
/Encoding 256 array
0 1 255 {1 index exch /.notdef put} for
dup 65 /A put
readonly def
currentdict end
currentfile eexec
"
        .to_vec();
        file.extend_from_slice(&encrypt(&private, EEXEC_ENCRYPT_KEY, &[1, 2, 3, 4]));
        file
    }

    #[test]
    fn a_binary_eexec_font_is_read_and_converted_glyph_by_glyph() {
        let font = Type1Font::parse(&small_font(), Type1Options::default()).unwrap();
        assert_eq!(font.charset(), vec![".notdef", ".notdef", "A"]);
        assert_eq!(font.font_matrix, Some(vec![0.001, 0.0, 0.0, 0.001, 0.0, 0.0]));
        assert_eq!(font.built_in_encoding, Some(BuiltInEncoding::Explicit(vec![(65, "A".to_string())])));
        let a = &font.glyphs[1];
        assert_eq!((a.glyph_name.as_str(), a.width, a.lsb), ("A", 600.0, 50.0));
        // hsbw becomes an hmoveto to the left side bearing (50, 0), the next moveto closes that contour with a line back
        // to it; then 100 100 rmoveto and two rlinetos; closepath is dropped, endchar ends the glyph
        let program = font.to_type2();
        let mut cmds = crate::glyph::Commands::new();
        program.compile(2, &mut cmds, &[]).unwrap();
        assert_eq!(cmds.into_path(), vec![0.0, 50.0, 0.0, 1.0, 50.0, 0.0, 0.0, 150.0, 100.0, 1.0, 250.0, 100.0, 1.0, 250.0, 200.0]);
    }

    #[test]
    fn a_font_with_a_wrong_length1_is_still_found_by_scanning_for_eexec() {
        let file = small_font();
        let font = Type1Font::parse(&file, Type1Options { length1: Some(10), composite: false }).unwrap();
        assert_eq!(font.glyphs.len(), 2);
    }
}
