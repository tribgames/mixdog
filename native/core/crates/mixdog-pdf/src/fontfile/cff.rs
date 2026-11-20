//! The CFF (Type1C, CIDFontType0C, OpenType CFF table) font-program reader, ported from pdf.js 6.4.299
//! (`src/core/cff_parser.js`: `CFFParser`, `CFF`, `CFFStrings`, `CFFIndex`, `CFFDict`, `CFFCharset`, `CFFEncoding`,
//! `CFFFDSelect`, and `CFFFont._createBuiltInEncoding` / `getGlyphMapping` of `src/core/fonts.js`).
//!
//! What text extraction reads from a CFF program is read here: the header, the INDEX structures, the Top DICT and
//! the Private DICTs (defaultWidthX, nominalWidthX, Subrs), the charsets (predefined and custom), the encodings
//! (predefined, custom, with supplements), the CID-keyed structures (FDArray, FDSelect, ROS) and the glyph names of
//! the standard strings. The charstrings are run as far as pdf.js runs them to find a glyph's width: the same stack
//! machine, the same in-place repairs of the charstring bytes (which later glyphs and subroutines then see), the
//! same seac recording. The compiler that pdf.js uses to rewrite the program for the browser's font loader is not
//! part of text extraction and is not ported.
//!
//! Where pdf.js reads past the end of the data it gets `undefined`; this port reads 0 where the value is only
//! combined with `|` or `<<`, and fails with the error pdf.js's next step would throw where a missing value would
//! break the parse. One input makes pdf.js loop for ever (a charset of format 1 that ends inside its ranges); it
//! fails here as a `FormatError`.
//!
//! With `useSystemFonts` true (the reference configuration) pdf.js fetches standard font data only for the
//! non-embedded Symbol and ZapfDingbats; [`standard_font_data`] holds those two programs (`stdfonts/`, Foxit, credited
//! in the crate's NOTICE) and [`read_standard_font`] reads them as pdf.js does. The two Foxit files of pdfjs-dist
//! 6.4.299 are CFF programs although they are named `.pfb`, so they are read here and not by the Type 1 reader.

use std::collections::BTreeMap;

use crate::error::{PdfError, Result};
use crate::fonts::data::encodings::{EXPERT_ENCODING, STANDARD_ENCODING};

#[rustfmt::skip]
#[path = "stdfonts/cff_tables.rs"]
mod tables;

use tables::{CFF_STANDARD_STRINGS, EXPERT_CHARSET, EXPERT_SUBSET_CHARSET, ISO_ADOBE_CHARSET};

/// `NUM_STANDARD_CFF_STRINGS`.
pub const NUM_STANDARD_CFF_STRINGS: usize = 391;
const MAX_SUBR_NESTING: i32 = 10;
const MAX_FD_ARRAY_COUNT: usize = 256;
const DEFAULT_BLUE_SCALE: f64 = 0.039625;
const DEFAULT_BLUE_SHIFT: f64 = 7.0;
const DEFAULT_BLUE_FUZZ: f64 = 1.0;
const DEFAULT_EXPANSION_FACTOR: f64 = 0.06;

// ---- JavaScript number conversions --------------------------------------------------------------------------------

/// JavaScript `parseFloat(string)`: the longest decimal prefix, `NaN` when there is none.
pub(crate) fn js_parse_float(text: &str) -> f64 {
    let t = text.trim_start_matches(is_js_space);
    let b = t.as_bytes();
    let mut i = 0;
    let negative = b.first() == Some(&b'-');
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits_from = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut mantissa = i - digits_from;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let fraction_from = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        mantissa += i - fraction_from;
    }
    if mantissa == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let exponent_from = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > exponent_from {
            i = j;
        }
    }
    t[..i].parse::<f64>().unwrap_or(f64::NAN)
}

/// JavaScript `parseInt(string, 10)`: the leading integer, `NaN` when there is none.
pub(crate) fn js_parse_int(text: &str) -> f64 {
    let t = text.trim_start_matches(is_js_space);
    let b = t.as_bytes();
    let mut i = 0;
    let negative = b.first() == Some(&b'-');
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let digits_from = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == digits_from {
        return f64::NAN;
    }
    let value = t[digits_from..i].parse::<f64>().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

/// JavaScript `ToInt32` (`value | 0`).
pub(crate) fn js_to_int32(value: f64) -> i32 {
    if !value.is_finite() {
        return 0;
    }
    ((value.trunc() % 4_294_967_296.0) as i64) as i32
}

/// JavaScript's white space and line terminators: Rust's `is_whitespace` without U+0085, plus U+FEFF.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

fn nth(values: &[f64], i: usize) -> f64 {
    values.get(i).copied().unwrap_or(f64::NAN)
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

fn type_error(what: &str) -> PdfError {
    PdfError::Unknown(format!("TypeError: {what}"))
}

fn range_error() -> PdfError {
    PdfError::Unknown("RangeError: Offset is outside the bounds of the DataView".to_owned())
}

// ---- DICT layouts -------------------------------------------------------------------------------------------------

/// How `CFFDict.setByKey` stores a value: `num`, `sid` and `offset` keep the first operand, the others the list.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Number,
    List,
}

#[derive(Clone, Copy)]
enum DefaultValue {
    Null,
    Number(f64),
    List(&'static [f64]),
}

struct Layout {
    key: u16,
    name: &'static str,
    kind: Kind,
    default: DefaultValue,
}

impl std::fmt::Debug for Layout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name)
    }
}

/// The key of a two byte operator `12 second`.
const fn two(second: u16) -> u16 {
    (12 << 8) | second
}

const fn number(key: u16, name: &'static str, default: DefaultValue) -> Layout {
    Layout { key, name, kind: Kind::Number, default }
}

const fn list(key: u16, name: &'static str, default: DefaultValue) -> Layout {
    Layout { key, name, kind: Kind::List, default }
}

const NONE: DefaultValue = DefaultValue::Null;

const fn num(value: f64) -> DefaultValue {
    DefaultValue::Number(value)
}

/// `CFFTopDictLayout`.
static TOP_DICT_LAYOUT: [Layout; 34] = [
    list(two(30), "ROS", NONE),
    number(two(20), "SyntheticBase", NONE),
    number(0, "version", NONE),
    number(1, "Notice", NONE),
    number(two(0), "Copyright", NONE),
    number(2, "FullName", NONE),
    number(3, "FamilyName", NONE),
    number(4, "Weight", NONE),
    number(two(1), "isFixedPitch", num(0.0)),
    number(two(2), "ItalicAngle", num(0.0)),
    number(two(3), "UnderlinePosition", num(-100.0)),
    number(two(4), "UnderlineThickness", num(50.0)),
    number(two(5), "PaintType", num(0.0)),
    number(two(6), "CharstringType", num(2.0)),
    list(two(7), "FontMatrix", DefaultValue::List(&[0.001, 0.0, 0.0, 0.001, 0.0, 0.0])),
    number(13, "UniqueID", NONE),
    list(5, "FontBBox", DefaultValue::List(&[0.0, 0.0, 0.0, 0.0])),
    number(two(8), "StrokeWidth", num(0.0)),
    list(14, "XUID", NONE),
    number(15, "charset", num(0.0)),
    number(16, "Encoding", num(0.0)),
    number(17, "CharStrings", num(0.0)),
    list(18, "Private", NONE),
    number(two(21), "PostScript", NONE),
    number(two(22), "BaseFontName", NONE),
    list(two(23), "BaseFontBlend", NONE),
    number(two(31), "CIDFontVersion", num(0.0)),
    number(two(32), "CIDFontRevision", num(0.0)),
    number(two(33), "CIDFontType", num(0.0)),
    number(two(34), "CIDCount", num(8720.0)),
    number(two(35), "UIDBase", NONE),
    number(two(37), "FDSelect", NONE),
    number(two(36), "FDArray", NONE),
    number(two(38), "FontName", NONE),
];

/// `CFFPrivateDictLayout`.
static PRIVATE_DICT_LAYOUT: [Layout; 18] = [
    list(6, "BlueValues", NONE),
    list(7, "OtherBlues", NONE),
    list(8, "FamilyBlues", NONE),
    list(9, "FamilyOtherBlues", NONE),
    number(two(9), "BlueScale", num(DEFAULT_BLUE_SCALE)),
    number(two(10), "BlueShift", num(DEFAULT_BLUE_SHIFT)),
    number(two(11), "BlueFuzz", num(DEFAULT_BLUE_FUZZ)),
    number(10, "StdHW", NONE),
    number(11, "StdVW", NONE),
    list(two(12), "StemSnapH", NONE),
    list(two(13), "StemSnapV", NONE),
    number(two(14), "ForceBold", num(0.0)),
    number(two(17), "LanguageGroup", num(0.0)),
    number(two(18), "ExpansionFactor", num(DEFAULT_EXPANSION_FACTOR)),
    number(two(19), "initialRandomSeed", num(0.0)),
    number(20, "defaultWidthX", num(0.0)),
    number(21, "nominalWidthX", num(0.0)),
    number(19, "Subrs", NONE),
];

/// A value of a DICT: a number, or the operand list of a key whose type is a list.
#[derive(Debug, Clone, PartialEq)]
pub enum DictValue {
    Number(f64),
    List(Vec<f64>),
}

/// `CFFDict` (`CFFTopDict` and `CFFPrivateDict`).
#[derive(Debug, Clone)]
pub struct CffDict {
    layout: &'static [Layout],
    values: BTreeMap<u16, DictValue>,
    /// `privateDict` of a Top DICT or a Font DICT; `None` where pdf.js has `null`.
    pub private_dict: Option<Box<CffDict>>,
    /// `subrsIndex` of a Private DICT.
    pub subrs_index: Option<CffIndex>,
}

impl CffDict {
    fn new(layout: &'static [Layout]) -> Self {
        CffDict { layout, values: BTreeMap::new(), private_dict: None, subrs_index: None }
    }

    fn entry(&self, name: &str) -> Option<&'static Layout> {
        self.layout.iter().find(|l| l.name == name)
    }

    /// `setByKey`.
    fn set_by_key(&mut self, key: u16, value: Vec<f64>) {
        let Some(layout) = self.layout.iter().find(|l| l.key == key) else {
            return;
        };
        if value.is_empty() {
            return;
        }
        if value.iter().any(|v| v.is_nan()) {
            tracing::warn!("Invalid CFFDict value: {value:?} for key {key}.");
            return;
        }
        let stored = match layout.kind {
            Kind::Number => DictValue::Number(value[0]),
            Kind::List => DictValue::List(value),
        };
        self.values.insert(key, stored);
    }

    /// `setByName`; the names are the constants of this module.
    fn set_by_name(&mut self, name: &str, value: DictValue) {
        if let Some(layout) = self.entry(name) {
            self.values.insert(layout.key, value);
        }
    }

    /// `hasName`.
    pub fn has_name(&self, name: &str) -> bool {
        self.entry(name).is_some_and(|l| self.values.contains_key(&l.key))
    }

    /// `getByName`: the stored value, else the layout's default (`None` for `null`).
    pub fn get_by_name(&self, name: &str) -> Option<DictValue> {
        let layout = self.entry(name)?;
        if let Some(value) = self.values.get(&layout.key) {
            return Some(value.clone());
        }
        match layout.default {
            DefaultValue::Null => None,
            DefaultValue::Number(n) => Some(DictValue::Number(n)),
            DefaultValue::List(a) => Some(DictValue::List(a.to_vec())),
        }
    }

    /// A numeric entry: the stored number, else the default; `None` for `null`, for a list and for an unknown name.
    pub fn number(&self, name: &str) -> Option<f64> {
        match self.get_by_name(name)? {
            DictValue::Number(n) => Some(n),
            DictValue::List(_) => None,
        }
    }

    /// A list entry (`FontBBox`, `FontMatrix`, `Private`, ...).
    pub fn list(&self, name: &str) -> Option<Vec<f64>> {
        match self.get_by_name(name)? {
            DictValue::List(a) => Some(a),
            DictValue::Number(_) => None,
        }
    }

    fn remove_by_name(&mut self, name: &str) {
        if let Some(layout) = self.entry(name) {
            self.values.remove(&layout.key);
        }
    }
}

// ---- the parsed structures ----------------------------------------------------------------------------------------

/// `CFFHeader`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CffHeader {
    pub major: u8,
    pub minor: u8,
    pub hdr_size: u8,
    pub off_size: u8,
}

/// `CFFStrings`: the String INDEX, after the standard strings.
#[derive(Debug, Clone, Default)]
pub struct CffStrings {
    strings: Vec<String>,
}

impl CffStrings {
    /// `get(index)`: `None` where pdf.js gives `undefined`.
    pub fn get(&self, index: i64) -> Option<String> {
        if (0..NUM_STANDARD_CFF_STRINGS as i64).contains(&index) {
            return Some(CFF_STANDARD_STRINGS[index as usize].to_owned());
        }
        let at = index - NUM_STANDARD_CFF_STRINGS as i64;
        if at <= self.strings.len() as i64 {
            usize::try_from(at).ok().and_then(|at| self.strings.get(at).cloned())
        } else {
            Some(CFF_STANDARD_STRINGS[0].to_owned())
        }
    }

    /// `count`.
    pub fn count(&self) -> usize {
        self.strings.len()
    }
}

/// One object of an INDEX: a range of the font bytes, or the charstring `[14]` pdf.js puts in place of a glyph it
/// found invalid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IndexObject {
    Span(usize, usize),
    EndChar,
}

/// `CFFIndex`.
#[derive(Debug, Clone, Default)]
pub struct CffIndex {
    objects: Vec<IndexObject>,
}

impl CffIndex {
    /// `count`.
    pub fn count(&self) -> usize {
        self.objects.len()
    }

    fn get(&self, index: usize) -> Option<IndexObject> {
        self.objects.get(index).copied()
    }

    /// The byte length of object `index` (`get(index).length`).
    pub fn object_length(&self, index: usize) -> Option<usize> {
        match self.get(index)? {
            IndexObject::Span(start, end) => Some(end - start),
            IndexObject::EndChar => Some(1),
        }
    }
}

/// One glyph of a charset: a CID in a CID-keyed font, else a glyph name (`None` is `undefined`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CharsetEntry {
    Cid(u32),
    Name(Option<String>),
}

/// `CFFCharset`.
#[derive(Debug, Clone)]
pub struct CffCharset {
    pub predefined: bool,
    pub format: u8,
    pub charset: Vec<CharsetEntry>,
}

/// `CFFEncoding`: character code to glyph id (`-1` where a supplement names a glyph the charset lacks).
#[derive(Debug, Clone)]
pub struct CffEncoding {
    pub predefined: bool,
    pub format: u8,
    pub encoding: BTreeMap<u32, i64>,
}

/// `CFFFDSelect`: the Font DICT of each glyph (`None` where the table ended before the glyph).
#[derive(Debug, Clone)]
pub struct CffFdSelect {
    pub format: u8,
    fd_select: Vec<Option<u8>>,
}

impl CffFdSelect {
    /// `getFDIndex`: `-1` out of range, `None` where the entry is `undefined`.
    pub fn fd_index(&self, glyph_index: usize) -> Option<i64> {
        match self.fd_select.get(glyph_index) {
            Some(Some(fd)) => Some(i64::from(*fd)),
            Some(None) => None,
            None => Some(-1),
        }
    }

    /// The Font DICT index of every glyph.
    pub fn entries(&self) -> &[Option<u8>] {
        &self.fd_select
    }
}

/// `CFF`.
#[derive(Debug, Clone)]
pub struct Cff {
    pub header: CffHeader,
    pub names: Vec<String>,
    pub top_dict: CffDict,
    pub strings: CffStrings,
    pub global_subr_index: CffIndex,
    pub encoding: Option<CffEncoding>,
    pub charset: CffCharset,
    pub char_strings: CffIndex,
    pub fd_array: Vec<CffDict>,
    pub fd_select: Option<CffFdSelect>,
    pub is_cid_font: bool,
    pub char_string_count: usize,
    /// Glyph id to the four seac values (`adx ady bchar achar`) of a glyph that ends with seac.
    pub seacs: BTreeMap<usize, Vec<f64>>,
    /// Width of each glyph in glyph space: `nominalWidthX + width`, else `defaultWidthX` (`NaN` where the
    /// charstring left no number for it).
    pub widths: Vec<f64>,
    pub raw_file_length: usize,
}

/// The font properties the parser reads and sets (`properties` of `CFFParser`).
#[derive(Debug, Clone, Default)]
pub struct CffProperties {
    /// `bbox` of the FontDescriptor (`FontBBox`), when it has one.
    pub bbox: Option<Vec<f64>>,
    /// Set from the Top DICT.
    pub font_matrix: Option<Vec<f64>>,
    pub ascent: Option<f64>,
    pub descent: Option<f64>,
    pub ascent_scaled: bool,
    /// Set by [`read_cff_font`] from the program's own encoding (`CFFFont._createBuiltInEncoding`).
    pub built_in_encoding: Option<BTreeMap<u32, String>>,
}

impl Cff {
    /// `hasGlyphId`.
    pub fn has_glyph_id(&self, id: i64) -> bool {
        if id < 0 || id >= self.char_strings.count() as i64 {
            return false;
        }
        self.char_strings.object_length(id as usize).is_some_and(|len| len > 0)
    }

    /// `duplicateFirstGlyph`: glyph 0 is added once more at the end (the font loader's `.notdef` fix).
    pub fn duplicate_first_glyph(&mut self) {
        if self.char_strings.count() >= 65535 {
            tracing::warn!("Not enough space in charstrings to duplicate first glyph.");
            return;
        }
        if let Some(glyph_zero) = self.char_strings.get(0) {
            self.char_strings.objects.push(glyph_zero);
        }
        if self.is_cid_font
            && let Some(select) = self.fd_select.as_mut()
        {
            let first = select.fd_select.first().copied().flatten();
            select.fd_select.push(first);
        }
    }

    /// `CFFFont._createBuiltInEncoding`: character code to glyph name of the font's own encoding, `None` where
    /// pdf.js leaves `properties.builtInEncoding` unset.
    fn create_built_in_encoding(&self) -> Option<BTreeMap<u32, String>> {
        let encoding = self.encoding.as_ref()?;
        let mut map = BTreeMap::new();
        for (&code, &glyph_id) in &encoding.encoding {
            if glyph_id < 0 {
                continue;
            }
            if let Some(CharsetEntry::Name(Some(name))) = self.charset.charset.get(glyph_id as usize)
                && !name.is_empty()
            {
                map.insert(code, name.clone());
            }
        }
        if map.is_empty() { None } else { Some(map) }
    }

    /// The composite branch of `CFFFont.getGlyphMapping`: character code to glyph id. `char_code_of` is
    /// `cMap.charCodeOf`, `cid_to_gid_map` the font's `CIDToGIDMap` (CID to glyph id).
    pub fn composite_glyph_mapping(&self, char_code_of: impl Fn(u32) -> i64, cid_to_gid_map: Option<&BTreeMap<i64, i64>>) -> BTreeMap<i64, usize> {
        let inverse: Option<BTreeMap<i64, i64>> = cid_to_gid_map.filter(|m| !m.is_empty()).map(|m| m.iter().map(|(&cid, &gid)| (gid, cid)).collect());
        let mut map = BTreeMap::new();
        if self.is_cid_font {
            for (glyph_id, entry) in self.charset.charset.iter().enumerate() {
                let CharsetEntry::Cid(cid) = entry else {
                    continue;
                };
                let mut char_code = char_code_of(*cid);
                if let Some(mapped) = inverse.as_ref().and_then(|inv| inv.get(&char_code)) {
                    char_code = *mapped;
                }
                map.insert(char_code, glyph_id);
            }
        } else {
            for glyph_id in 0..self.char_strings.count() {
                map.insert(char_code_of(glyph_id as u32), glyph_id);
            }
        }
        map
    }
}

// ---- charstring validation data -----------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum StackFn {
    Add,
    Sub,
    Div,
    Neg,
    Mul,
}

/// One entry of `CharstringValidationData` / `CharstringValidationData12`.
struct Command {
    id: &'static str,
    min: i64,
    stack_clearing: bool,
    reset_stack: bool,
    stem: bool,
    stack_delta: Option<i64>,
    stack_fn: Option<StackFn>,
}

const fn command(id: &'static str, min: i64) -> Command {
    Command { id, min, stack_clearing: false, reset_stack: false, stem: false, stack_delta: None, stack_fn: None }
}

const fn clearing(id: &'static str, min: i64) -> Command {
    Command { stack_clearing: true, ..command(id, min) }
}

const fn stem(id: &'static str, min: i64) -> Command {
    Command { stack_clearing: true, stem: true, ..command(id, min) }
}

const fn reset(id: &'static str, min: i64) -> Command {
    Command { reset_stack: true, ..command(id, min) }
}

const fn delta(id: &'static str, min: i64, stack_delta: i64) -> Command {
    Command { stack_delta: Some(stack_delta), ..command(id, min) }
}

const fn compute(id: &'static str, min: i64, stack_delta: i64, f: StackFn) -> Command {
    Command { stack_delta: Some(stack_delta), stack_fn: Some(f), ..command(id, min) }
}

/// `CharstringValidationData`, by operator.
static COMMANDS: [Option<Command>; 32] = [
    None,
    Some(stem("hstem", 2)),
    None,
    Some(stem("vstem", 2)),
    Some(clearing("vmoveto", 1)),
    Some(reset("rlineto", 2)),
    Some(reset("hlineto", 1)),
    Some(reset("vlineto", 1)),
    Some(reset("rrcurveto", 6)),
    None,
    Some(command("callsubr", 1)),
    Some(command("return", 0)),
    None,
    None,
    Some(clearing("endchar", 0)),
    None,
    None,
    None,
    Some(stem("hstemhm", 2)),
    Some(clearing("hintmask", 0)),
    Some(clearing("cntrmask", 0)),
    Some(clearing("rmoveto", 2)),
    Some(clearing("hmoveto", 1)),
    Some(stem("vstemhm", 2)),
    Some(reset("rcurveline", 8)),
    Some(reset("rlinecurve", 8)),
    Some(reset("vvcurveto", 4)),
    Some(reset("hhcurveto", 4)),
    None,
    Some(command("callgsubr", 1)),
    Some(reset("vhcurveto", 4)),
    Some(reset("hvcurveto", 4)),
];

/// `CharstringValidationData12`, by the second byte of an escaped operator.
static COMMANDS_12: [Option<Command>; 38] = [
    None,
    None,
    None,
    Some(delta("and", 2, -1)),
    Some(delta("or", 2, -1)),
    Some(delta("not", 1, 0)),
    None,
    None,
    None,
    Some(delta("abs", 1, 0)),
    Some(compute("add", 2, -1, StackFn::Add)),
    Some(compute("sub", 2, -1, StackFn::Sub)),
    Some(compute("div", 2, -1, StackFn::Div)),
    None,
    Some(compute("neg", 1, 0, StackFn::Neg)),
    Some(delta("eq", 2, -1)),
    None,
    None,
    Some(delta("drop", 1, -1)),
    None,
    Some(delta("put", 2, -2)),
    Some(delta("get", 1, 0)),
    Some(delta("ifelse", 4, -3)),
    Some(delta("random", 0, 1)),
    Some(compute("mul", 2, -1, StackFn::Mul)),
    None,
    Some(delta("sqrt", 1, 0)),
    Some(delta("dup", 1, 1)),
    Some(delta("exch", 2, 0)),
    Some(delta("index", 2, 0)),
    Some(delta("roll", 3, -2)),
    None,
    None,
    None,
    Some(reset("hflex", 7)),
    Some(reset("flex", 13)),
    Some(reset("hflex1", 9)),
    Some(reset("flex1", 11)),
];

/// What `parseCharStrings` returns: the charstrings, the seac records and the glyph widths.
type ParsedCharStrings = (CffIndex, BTreeMap<usize, Vec<f64>>, Vec<f64>);

/// The charstring stack: a JavaScript array, so an index below 0 is a property and an index never written is
/// `undefined` (`NaN` when read).
#[derive(Default)]
struct Stack {
    values: Vec<f64>,
    negative: BTreeMap<i64, f64>,
}

impl Stack {
    fn get(&self, index: i64) -> f64 {
        if index >= 0 { self.values.get(index as usize).copied().unwrap_or(f64::NAN) } else { self.negative.get(&index).copied().unwrap_or(f64::NAN) }
    }

    fn set(&mut self, index: i64, value: f64) {
        if index >= 0 {
            let index = index as usize;
            if index >= self.values.len() {
                self.values.resize(index + 1, f64::NAN);
            }
            self.values[index] = value;
        } else {
            self.negative.insert(index, value);
        }
    }

    /// `slice(from, from + count)`.
    fn slice(&self, from: usize, count: usize) -> Vec<f64> {
        self.values.iter().skip(from).take(count).copied().collect()
    }
}

/// The `state` object of `parseCharString`.
struct CharStringState {
    call_depth: i32,
    stack_size: i64,
    stack: Stack,
    hints: i64,
    first_stack_clearing: bool,
    seac: Option<Vec<f64>>,
    width: Option<f64>,
    has_vstems: bool,
}

impl CharStringState {
    fn new() -> Self {
        CharStringState {
            call_depth: 0,
            stack_size: 0,
            stack: Stack::default(),
            hints: 0,
            first_stack_clearing: true,
            seac: None,
            width: None,
            has_vstems: false,
        }
    }
}

// ---- the parser ---------------------------------------------------------------------------------------------------

/// `CFFParser` with seac analysis on, as pdf.js runs it. It owns a copy of the font bytes because pdf.js repairs
/// charstrings in place.
struct CffParser {
    bytes: Vec<u8>,
}

/// `new CFFFont(file, properties)`: parse a CFF font program, add the duplicate of glyph 0 and set the built-in
/// encoding. `properties` is read (`bbox`) and set (`font_matrix`, `ascent`, `descent`, `built_in_encoding`) as
/// pdf.js does.
pub fn read_cff_font(bytes: &[u8], properties: &mut CffProperties) -> Result<Cff> {
    let mut cff = CffParser { bytes: bytes.to_vec() }.parse(properties)?;
    if cff.char_strings.count() == 0 {
        // `duplicateFirstGlyph` adds `charStrings.get(0)`, which is `undefined` here: pdf.js throws.
        return Err(type_error("cannot read properties of undefined (reading 'length')"));
    }
    cff.duplicate_first_glyph();
    if let Some(map) = cff.create_built_in_encoding() {
        properties.built_in_encoding = Some(map);
    }
    Ok(cff)
}

static FOXIT_SYMBOL: &[u8] = include_bytes!("stdfonts/FoxitSymbol.pfb");
static FOXIT_DINGBATS: &[u8] = include_bytes!("stdfonts/FoxitDingbats.pfb");

/// `fetchStandardFontData(name)` with `useSystemFonts` true: the program of Symbol and ZapfDingbats, `None` for any
/// other name (pdf.js then uses a system font).
pub fn standard_font_data(name: &str) -> Option<&'static [u8]> {
    match name {
        "Symbol" => Some(FOXIT_SYMBOL),
        "ZapfDingbats" => Some(FOXIT_DINGBATS),
        _ => None,
    }
}

/// Read the standard font `name` as pdf.js does, `None` where there is no program for the name.
pub fn read_standard_font(name: &str, properties: &mut CffProperties) -> Option<Result<Cff>> {
    let data = standard_font_data(name)?;
    Some(read_cff_font(data, properties))
}

impl CffParser {
    /// `bytes[pos]`, `None` for `undefined`.
    fn get(&self, pos: i64) -> Option<u8> {
        usize::try_from(pos).ok().and_then(|p| self.bytes.get(p)).copied()
    }

    /// `bytes[pos]` where an absent byte combines as 0.
    fn at(&self, pos: i64) -> u32 {
        self.get(pos).map_or(0, u32::from)
    }

    /// `bytes[pos] << 8 | bytes[pos + 1]`.
    fn u16_at(&self, pos: i64) -> u32 {
        (self.at(pos) << 8) | self.at(pos + 1)
    }

    /// `DataView.getInt16` at the absolute byte `at` (a read past the buffer is a `RangeError`).
    fn view_i16(&self, at: usize) -> Result<i16> {
        let b = self.bytes.get(at..at + 2).ok_or_else(range_error)?;
        Ok(i16::from_be_bytes([b[0], b[1]]))
    }

    fn view_i32(&self, at: usize) -> Result<i32> {
        let b = self.bytes.get(at..at + 4).ok_or_else(range_error)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn parse(mut self, properties: &mut CffProperties) -> Result<Cff> {
        let header = self.parse_header()?;
        let (name_index, name_end) = self.parse_index(i64::from(header.hdr_size))?;
        let (top_dict_index, top_dict_end) = self.parse_index(name_end)?;
        let (string_index, string_end) = self.parse_index(top_dict_end)?;
        let (global_subr_index, _) = self.parse_index(string_end)?;
        let top_dict_parsed = match top_dict_index.get(0) {
            Some(IndexObject::Span(start, end)) => self.parse_dict(start, end)?,
            // `parseDict(undefined)` throws a TypeError.
            _ => {
                return Err(type_error("cannot read properties of undefined (reading 'buffer')"));
            }
        };
        let mut top_dict = create_dict(&TOP_DICT_LAYOUT, top_dict_parsed);
        let names = self.parse_name_index(&name_index);
        let strings = self.parse_string_index(&string_index);
        self.parse_private_dict(&mut top_dict)?;
        let is_cid_font = top_dict.has_name("ROS");
        let char_string_offset = top_dict.number("CharStrings").unwrap_or(0.0);
        let (char_string_index, _) = self.parse_index(char_string_offset as i64)?;
        let char_string_count = char_string_index.count();
        properties.font_matrix = top_dict.list("FontMatrix");
        self.recover_font_bbox(&mut top_dict, properties);
        let mut fd_array = Vec::new();
        let charset;
        let encoding;
        let fd_select;
        if is_cid_font {
            let fd_array_offset = top_dict.number("FDArray").unwrap_or(0.0);
            let (fd_array_index, _) = self.parse_index(fd_array_offset as i64)?;
            let mut fd_array_count = fd_array_index.count();
            if fd_array_count > MAX_FD_ARRAY_COUNT {
                tracing::warn!("CFFParser.parse: too many FDArray entries ({fd_array_count}).");
                fd_array_count = MAX_FD_ARRAY_COUNT;
            }
            for i in 0..fd_array_count {
                let Some(IndexObject::Span(start, end)) = fd_array_index.get(i) else {
                    continue;
                };
                let parsed = self.parse_dict(start, end)?;
                let mut font_dict = create_dict(&TOP_DICT_LAYOUT, parsed);
                self.parse_private_dict(&mut font_dict)?;
                fd_array.push(font_dict);
            }
            encoding = None;
            charset = self.parse_charsets(top_dict.number("charset").unwrap_or(0.0) as i64, char_string_count as i64, &strings, true)?;
            fd_select = Some(self.parse_fd_select(top_dict.number("FDSelect").unwrap_or(0.0) as i64, char_string_count)?);
        } else {
            charset = self.parse_charsets(top_dict.number("charset").unwrap_or(0.0) as i64, char_string_count as i64, &strings, false)?;
            encoding = Some(self.parse_encoding(top_dict.number("Encoding").unwrap_or(0.0) as i64, &strings, &charset.charset)?);
            fd_select = None;
        }
        let local_subr_index = match &top_dict.private_dict {
            Some(private) => private.subrs_index.clone(),
            None => {
                return Err(type_error("cannot read properties of null (reading 'subrsIndex')"));
            }
        };
        let (char_strings, seacs, widths) = self.parse_char_strings(
            char_string_index,
            local_subr_index.as_ref(),
            &global_subr_index,
            fd_select.as_ref(),
            &fd_array,
            top_dict.private_dict.as_deref(),
        )?;
        let raw_file_length = self.bytes.len();
        Ok(Cff {
            header,
            names,
            top_dict,
            strings,
            global_subr_index,
            encoding,
            charset,
            char_strings,
            fd_array,
            fd_select,
            is_cid_font,
            char_string_count,
            seacs,
            widths,
            raw_file_length,
        })
    }

    /// The `FontBBox` handling of `parse`: a box stored as unsigned 16 bit numbers is read as signed where the
    /// descriptor's box agrees or the lower left is out of range; an empty box is replaced by the descriptor's;
    /// a non-empty box sets `ascent` and `descent`.
    fn recover_font_bbox(&self, top_dict: &mut CffDict, properties: &mut CffProperties) {
        let mut font_bbox = top_dict.list("FontBBox");
        let descriptor_bbox = match &properties.bbox {
            Some(b) if b.iter().any(|&c| c != 0.0) => Some(recover_signed_16_bit_bbox(b, false)),
            _ => None,
        };
        let has_unsigned_lower_left = font_bbox.as_ref().is_some_and(|b| b.iter().take(2).any(|&c| looks_like_unsigned_16_bit_negative(c)));
        let has_unsigned_coords = font_bbox.as_ref().is_some_and(|b| b.iter().any(|&c| looks_like_unsigned_16_bit_negative(c)));
        if font_bbox.as_ref().is_some_and(|b| b.iter().all(|&c| c == 0.0))
            && let Some(descriptor) = &descriptor_bbox
        {
            font_bbox = Some(descriptor.clone());
            top_dict.set_by_name("FontBBox", DictValue::List(descriptor.clone()));
        } else if has_unsigned_coords {
            let current = font_bbox.clone().unwrap_or_default();
            let recovered = recover_signed_16_bit_bbox(&current, false);
            let descriptor_corroborates = match (&descriptor_bbox, &properties.bbox) {
                (Some(descriptor), Some(raw)) => {
                    raw.iter().any(|&c| c < 0.0) && !raw.iter().any(|&c| looks_like_unsigned_16_bit_negative(c)) && is_array_equal(&recovered, descriptor)
                }
                _ => false,
            };
            if descriptor_corroborates || has_unsigned_lower_left {
                let next = if descriptor_corroborates { recovered } else { recover_signed_16_bit_bbox(&current, true) };
                top_dict.set_by_name("FontBBox", DictValue::List(next.clone()));
                font_bbox = Some(next);
            }
        }
        if let Some(bbox) = &font_bbox
            && bbox.iter().any(|&c| c != 0.0)
        {
            properties.ascent = Some(js_max(nth(bbox, 3), nth(bbox, 1)));
            properties.descent = Some(js_min(nth(bbox, 1), nth(bbox, 3)));
            properties.ascent_scaled = true;
        }
    }

    fn parse_header(&mut self) -> Result<CffHeader> {
        let length = self.bytes.len();
        let mut offset = 0;
        while offset < length && self.bytes[offset] != 1 {
            offset += 1;
        }
        if offset >= length {
            return Err(PdfError::Format("Invalid CFF header".to_owned()));
        }
        if offset != 0 {
            tracing::info!("cff data is shifted");
            self.bytes.drain(..offset);
        }
        let byte = |i: usize| self.bytes.get(i).copied().unwrap_or(0);
        Ok(CffHeader { major: byte(0), minor: byte(1), hdr_size: byte(2), off_size: byte(3) })
    }

    /// `parseDict` of the bytes `start..end`: the `(operator, operands)` entries.
    fn parse_dict(&self, start: usize, end: usize) -> Result<Vec<(u16, Vec<f64>)>> {
        const FLOAT_NIBBLES: [&str; 15] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "E", "E-", "null", "-"];
        let length = end.saturating_sub(start);
        let d = |pos: usize| -> Option<u8> { if pos < length { self.bytes.get(start + pos).copied() } else { None } };
        let mut entries = Vec::new();
        let mut operands: Vec<f64> = Vec::new();
        let mut pos = 0usize;
        while pos < length {
            let mut b = u32::from(d(pos).unwrap_or(0));
            if b <= 21 {
                if b == 12 {
                    pos += 1;
                    b = (b << 8) | u32::from(d(pos).unwrap_or(0));
                }
                entries.push((b as u16, std::mem::take(&mut operands)));
                pos += 1;
                continue;
            }
            pos += 1;
            let operand = match b {
                30 => {
                    let mut text = String::new();
                    while pos < length {
                        let byte = d(pos).unwrap_or(0);
                        pos += 1;
                        let (b1, b2) = (byte >> 4, byte & 15);
                        if b1 == 15 {
                            break;
                        }
                        text.push_str(FLOAT_NIBBLES[usize::from(b1)]);
                        if b2 == 15 {
                            break;
                        }
                        text.push_str(FLOAT_NIBBLES[usize::from(b2)]);
                    }
                    js_parse_float(&text)
                }
                28 => {
                    let v = self.view_i16(start + pos)?;
                    pos += 2;
                    f64::from(v)
                }
                29 => {
                    let v = self.view_i32(start + pos)?;
                    pos += 4;
                    f64::from(v)
                }
                32..=246 => f64::from(b) - 139.0,
                247..=250 => {
                    let next = d(pos);
                    pos += 1;
                    next.map_or(f64::NAN, |n| f64::from((b - 247) * 256 + u32::from(n) + 108))
                }
                251..=254 => {
                    let next = d(pos);
                    pos += 1;
                    next.map_or(f64::NAN, |n| -f64::from((b - 251) * 256) - f64::from(n) - 108.0)
                }
                _ => {
                    tracing::warn!("CFFParser.parseDict: \"{b}\" is a reserved command.");
                    f64::NAN
                }
            };
            operands.push(operand);
        }
        Ok(entries)
    }

    /// `parseIndex`: the INDEX at `pos` and the position after it.
    fn parse_index(&self, mut pos: i64) -> Result<(CffIndex, i64)> {
        let count = i64::from(self.u16_at(pos));
        pos += 2;
        let mut offsets: Vec<i64> = Vec::new();
        let mut end = pos;
        if count != 0 {
            let offset_size = self.get(pos);
            pos += 1;
            let offset_size = match offset_size {
                Some(size @ 1..=4) => i64::from(size),
                Some(size) => {
                    return Err(PdfError::Format(format!("Invalid CFF INDEX offset size: {size}")));
                }
                None => {
                    return Err(PdfError::Format("Invalid CFF INDEX offset size: undefined".to_owned()));
                }
            };
            let start_pos = pos + (count + 1) * offset_size - 1;
            let bytes_length = self.bytes.len() as i64;
            let mut prev_offset = start_pos;
            for _ in 0..=count {
                let mut offset: i32 = 0;
                for _ in 0..offset_size {
                    offset = (offset << 8) | self.at(pos) as i32;
                    pos += 1;
                }
                prev_offset = (start_pos + i64::from(offset)).max(prev_offset).min(bytes_length);
                offsets.push(prev_offset);
            }
            end = offsets[count as usize];
        }
        let objects = offsets.windows(2).map(|w| IndexObject::Span(w[0].max(0) as usize, w[1].max(0) as usize)).collect();
        Ok((CffIndex { objects }, end))
    }

    fn parse_name_index(&self, index: &CffIndex) -> Vec<String> {
        (0..index.count())
            .filter_map(|i| match index.get(i) {
                Some(IndexObject::Span(s, e)) => Some(latin1(&self.bytes[s..e])),
                _ => None,
            })
            .collect()
    }

    fn parse_string_index(&self, index: &CffIndex) -> CffStrings {
        CffStrings { strings: self.parse_name_index(index) }
    }

    /// `parseCharString`: `Ok(false)` is pdf.js's `false` (the charstring is not usable), an `Err` an exception.
    fn parse_char_string(
        &mut self,
        state: &mut CharStringState,
        data: Option<IndexObject>,
        local_subr_index: Option<&CffIndex>,
        global_subr_index: &CffIndex,
    ) -> Result<bool> {
        let Some(IndexObject::Span(base, end)) = data else {
            return Ok(false);
        };
        if state.call_depth > MAX_SUBR_NESTING {
            return Ok(false);
        }
        let data_len = end - base;
        let mut stack_size = state.stack_size;
        let mut length = data_len;
        let mut j = 0usize;
        while j < length {
            let value = u32::from(self.bytes[base + j]);
            j += 1;
            let mut validation: Option<&'static Command> = None;
            if value == 12 {
                let q = if j < data_len { Some(self.bytes[base + j]) } else { None };
                j += 1;
                match q {
                    Some(0) => {
                        self.bytes[base + j - 2] = 139;
                        self.bytes[base + j - 1] = 22;
                        stack_size = 0;
                    }
                    Some(q) => {
                        validation = COMMANDS_12.get(usize::from(q)).and_then(Option::as_ref);
                    }
                    None => {}
                }
            } else if value == 28 {
                let v = self.view_i16(base + j)?;
                state.stack.set(stack_size, f64::from(v));
                j += 2;
                stack_size += 1;
            } else if value == 14 {
                if stack_size >= 4 {
                    stack_size -= 4;
                    state.seac = Some(state.stack.slice(stack_size as usize, 4));
                    return Ok(false);
                }
                validation = COMMANDS[14].as_ref();
            } else if (32..=246).contains(&value) {
                state.stack.set(stack_size, f64::from(value) - 139.0);
                stack_size += 1;
            } else if (247..=254).contains(&value) {
                let next = if j < data_len { Some(f64::from(self.bytes[base + j])) } else { None };
                let number = match next {
                    Some(n) if value < 251 => f64::from((value - 247) << 8) + n + 108.0,
                    Some(n) => -f64::from((value - 251) << 8) - n - 108.0,
                    None => f64::NAN,
                };
                state.stack.set(stack_size, number);
                j += 1;
                stack_size += 1;
            } else if value == 255 {
                let v = self.view_i32(base + j)?;
                state.stack.set(stack_size, f64::from(v) / 65536.0);
                j += 4;
                stack_size += 1;
            } else if value == 19 || value == 20 {
                state.hints += stack_size >> 1;
                if state.hints == 0 {
                    self.copy_within(base, data_len, j);
                    j -= 1;
                    length -= 1;
                    continue;
                }
                j += ((state.hints + 7) >> 3) as usize;
                stack_size %= 2;
                validation = COMMANDS[value as usize].as_ref();
            } else if value == 10 || value == 29 {
                let subrs = if value == 10 { local_subr_index } else { Some(global_subr_index) };
                let id = COMMANDS[value as usize].as_ref().map_or("", |c| c.id);
                let Some(subrs) = subrs else {
                    tracing::warn!("Missing subrsIndex for {id}");
                    return Ok(false);
                };
                let count = subrs.count();
                let bias = if count < 1240 {
                    107.0
                } else if count < 33900 {
                    1131.0
                } else {
                    32768.0
                };
                stack_size -= 1;
                let subr_number = state.stack.get(stack_size) + bias;
                if subr_number < 0.0 || subr_number >= count as f64 || subr_number.is_nan() {
                    tracing::warn!("Out of bounds subrIndex for {id}");
                    return Ok(false);
                }
                state.stack_size = stack_size;
                state.call_depth += 1;
                let callee = if subr_number.fract() == 0.0 { subrs.get(subr_number as usize) } else { None };
                let valid = self.parse_char_string(state, callee, local_subr_index, global_subr_index)?;
                if !valid {
                    return Ok(false);
                }
                state.call_depth -= 1;
                stack_size = state.stack_size;
                continue;
            } else if value == 11 {
                state.stack_size = stack_size;
                return Ok(true);
            } else if value == 0 && j == data_len {
                self.bytes[base + j - 1] = 14;
                validation = COMMANDS[14].as_ref();
            } else if value == 9 {
                self.copy_within(base, data_len, j);
                j -= 1;
                length -= 1;
                continue;
            } else {
                validation = COMMANDS.get(value as usize).and_then(Option::as_ref);
            }
            let Some(command) = validation else {
                continue;
            };
            if command.stem {
                state.hints += stack_size >> 1;
                if value == 3 || value == 23 {
                    state.has_vstems = true;
                } else if state.has_vstems && (value == 1 || value == 18) {
                    tracing::warn!("CFF stem hints are in wrong order");
                    self.bytes[base + j - 1] = if value == 1 { 3 } else { 23 };
                }
            }
            if stack_size < command.min {
                tracing::warn!("Not enough parameters for {}; actual: {}, expected: {}", command.id, stack_size, command.min);
                if stack_size == 0 {
                    self.bytes[base + j - 1] = 14;
                    return Ok(true);
                }
                return Ok(false);
            }
            if state.first_stack_clearing && command.stack_clearing {
                state.first_stack_clearing = false;
                stack_size -= command.min;
                if stack_size >= 2 && command.stem {
                    stack_size %= 2;
                } else if stack_size > 1 {
                    tracing::warn!("Found too many parameters for stack-clearing command");
                }
                if stack_size > 0 {
                    state.width = Some(state.stack.get(stack_size - 1));
                }
            }
            if let Some(stack_delta) = command.stack_delta {
                if let Some(f) = command.stack_fn {
                    let a = state.stack.get(stack_size - 2);
                    let b = state.stack.get(stack_size - 1);
                    match f {
                        StackFn::Add => state.stack.set(stack_size - 2, a + b),
                        StackFn::Sub => state.stack.set(stack_size - 2, a - b),
                        StackFn::Div => state.stack.set(stack_size - 2, a / b),
                        StackFn::Mul => state.stack.set(stack_size - 2, a * b),
                        StackFn::Neg => state.stack.set(stack_size - 1, -b),
                    }
                }
                stack_size += stack_delta;
            } else if command.stack_clearing || command.reset_stack {
                stack_size = 0;
            }
        }
        if length < data_len {
            self.bytes[base + length..base + data_len].fill(14);
        }
        state.stack_size = stack_size;
        Ok(true)
    }

    /// `data.copyWithin(j - 1, j, -1)` on the charstring `base..base + data_len`.
    fn copy_within(&mut self, base: usize, data_len: usize, j: usize) {
        if j < data_len {
            self.bytes.copy_within(base + j..base + data_len - 1, base + j - 1);
        }
    }

    fn parse_char_strings(
        &mut self,
        mut char_strings: CffIndex,
        local_subr_index: Option<&CffIndex>,
        global_subr_index: &CffIndex,
        fd_select: Option<&CffFdSelect>,
        fd_array: &[CffDict],
        private_dict: Option<&CffDict>,
    ) -> Result<ParsedCharStrings> {
        let mut seacs = BTreeMap::new();
        let mut widths = Vec::new();
        for i in 0..char_strings.count() {
            let charstring = char_strings.get(i);
            let mut state = CharStringState::new();
            let mut valid = true;
            let mut local_to_use: Option<&CffIndex> = None;
            let mut private_to_use = private_dict;
            match fd_select {
                Some(select) if !fd_array.is_empty() => {
                    let Some(fd_index) = select.fd_index(i) else {
                        return Err(type_error("cannot read properties of undefined (reading 'privateDict')"));
                    };
                    if fd_index == -1 {
                        tracing::warn!("Glyph index is not in fd select.");
                        valid = false;
                    }
                    if fd_index >= fd_array.len() as i64 {
                        tracing::warn!("Invalid fd index for glyph index.");
                        valid = false;
                    }
                    if valid {
                        let Some(private) = fd_array[fd_index as usize].private_dict.as_deref() else {
                            return Err(type_error("cannot read properties of null (reading 'subrsIndex')"));
                        };
                        private_to_use = Some(private);
                        local_to_use = private.subrs_index.as_ref();
                    }
                }
                _ => local_to_use = local_subr_index,
            }
            if valid {
                valid = self.parse_char_string(&mut state, charstring, local_to_use, global_subr_index)?;
            }
            let Some(private) = private_to_use else {
                return Err(type_error("cannot read properties of null (reading 'getByName')"));
            };
            match state.width {
                Some(width) => {
                    widths.push(private.number("nominalWidthX").unwrap_or(0.0) + width);
                }
                None => widths.push(private.number("defaultWidthX").unwrap_or(0.0)),
            }
            if let Some(seac) = state.seac {
                seacs.insert(i, seac);
            }
            if !valid {
                char_strings.objects[i] = IndexObject::EndChar;
            }
        }
        Ok((char_strings, seacs, widths))
    }

    /// `emptyPrivateDictionary`.
    fn empty_private_dictionary(parent: &mut CffDict) {
        parent.set_by_key(18, vec![0.0, 0.0]);
        parent.private_dict = Some(Box::new(CffDict::new(&PRIVATE_DICT_LAYOUT)));
    }

    fn parse_private_dict(&mut self, parent: &mut CffDict) -> Result<()> {
        if !parent.has_name("Private") {
            Self::empty_private_dictionary(parent);
            return Ok(());
        }
        let Some(&[size, offset]) = parent.list("Private").as_deref().filter(|a| a.len() == 2) else {
            parent.remove_by_name("Private");
            return Ok(());
        };
        let length = self.bytes.len() as f64;
        if size == 0.0 || offset >= length {
            Self::empty_private_dictionary(parent);
            return Ok(());
        }
        if offset + size > length {
            return Err(PdfError::Format("CFF Private DICT extends past end of font".to_owned()));
        }
        let start = offset.max(0.0) as usize;
        let end = (offset + size).max(0.0) as usize;
        let dict = self.parse_dict(start, end.max(start))?;
        let mut private = create_dict(&PRIVATE_DICT_LAYOUT, dict);
        let blue_scale = private.number("BlueScale").unwrap_or(f64::NAN);
        let blue_shift = private.number("BlueShift").unwrap_or(f64::NAN);
        let blue_fuzz = private.number("BlueFuzz").unwrap_or(f64::NAN);
        let expansion_factor = private.number("ExpansionFactor").unwrap_or(f64::NAN);
        if blue_scale == 0.0 && blue_shift == 0.0 && blue_fuzz == 0.0 && expansion_factor == 0.0 {
            private.set_by_name("BlueScale", DictValue::Number(DEFAULT_BLUE_SCALE));
            private.set_by_name("BlueShift", DictValue::Number(DEFAULT_BLUE_SHIFT));
            private.set_by_name("BlueFuzz", DictValue::Number(DEFAULT_BLUE_FUZZ));
        }
        if expansion_factor == 0.0 {
            private.set_by_name("ExpansionFactor", DictValue::Number(DEFAULT_EXPANSION_FACTOR));
        }
        if blue_scale > 0.0 {
            let mut max_zone_height = 0.0f64;
            for name in ["BlueValues", "OtherBlues"] {
                let Some(zones) = private.list(name) else {
                    continue;
                };
                for zone in zones.iter().skip(1).step_by(2) {
                    if *zone > max_zone_height {
                        max_zone_height = *zone;
                    }
                }
            }
            if max_zone_height > 0.0 {
                const PRECISION: f64 = 1e5;
                let lower_bound = 0.5 / max_zone_height;
                let min_blue_scale = if lower_bound <= DEFAULT_BLUE_SCALE { (lower_bound * PRECISION).ceil() / PRECISION } else { f64::NEG_INFINITY };
                let max_blue_scale = (PRECISION / max_zone_height).floor() / PRECISION;
                let clamped = blue_scale.max(min_blue_scale).min(max_blue_scale);
                if clamped != blue_scale {
                    private.set_by_name("BlueScale", DictValue::Number(clamped));
                }
            }
        }
        let subrs_offset = private.number("Subrs").unwrap_or(0.0);
        if subrs_offset == 0.0 {
            parent.private_dict = Some(Box::new(private));
            return Ok(());
        }
        let relative_offset = offset + subrs_offset;
        if relative_offset >= length {
            Self::empty_private_dictionary(parent);
            return Ok(());
        }
        let (subrs_index, _) = self.parse_index(relative_offset as i64)?;
        private.subrs_index = Some(subrs_index);
        parent.private_dict = Some(Box::new(private));
        Ok(())
    }

    fn parse_charsets(&self, pos: i64, length: i64, strings: &CffStrings, cid: bool) -> Result<CffCharset> {
        let predefined = |format: u8, names: &[&str]| CffCharset {
            predefined: true,
            format,
            charset: names.iter().map(|n| CharsetEntry::Name(Some((*n).to_owned()))).collect(),
        };
        match pos {
            0 => return Ok(predefined(0, &ISO_ADOBE_CHARSET)),
            1 => return Ok(predefined(1, &EXPERT_CHARSET)),
            2 => return Ok(predefined(2, &EXPERT_SUBSET_CHARSET)),
            _ => {}
        }
        let mut pos = pos;
        let format = self.get(pos);
        pos += 1;
        let mut charset = vec![if cid { CharsetEntry::Cid(0) } else { CharsetEntry::Name(Some(".notdef".to_owned())) }];
        let entry = |id: i64| {
            if cid { CharsetEntry::Cid(id as u32) } else { CharsetEntry::Name(strings.get(id)) }
        };
        let length = length - 1;
        match format {
            Some(0) => {
                for _ in 0..length.max(0) {
                    let id = i64::from(self.u16_at(pos));
                    pos += 2;
                    charset.push(entry(id));
                }
            }
            Some(format @ (1 | 2)) => {
                while charset.len() as i64 <= length {
                    let id = i64::from(self.u16_at(pos));
                    pos += 2;
                    let count = if format == 1 {
                        let Some(count) = self.get(pos) else {
                            return Err(PdfError::Format("CFF charset ends inside its ranges".to_owned()));
                        };
                        pos += 1;
                        i64::from(count)
                    } else {
                        let count = self.u16_at(pos);
                        pos += 2;
                        i64::from(count)
                    };
                    for k in 0..=count {
                        charset.push(entry(id + k));
                    }
                }
            }
            _ => return Err(PdfError::Format("Unknown charset format".to_owned())),
        }
        Ok(CffCharset { predefined: false, format: format.unwrap_or(0), charset })
    }

    fn parse_encoding(&mut self, pos: i64, strings: &CffStrings, charset: &[CharsetEntry]) -> Result<CffEncoding> {
        let mut encoding: BTreeMap<u32, i64> = BTreeMap::new();
        if pos == 0 || pos == 1 {
            let base_encoding: &[&str; 256] = if pos == 1 { &EXPERT_ENCODING } else { &STANDARD_ENCODING };
            for (i, entry) in charset.iter().enumerate() {
                let CharsetEntry::Name(Some(name)) = entry else {
                    continue;
                };
                if let Some(index) = base_encoding.iter().position(|n| *n == name.as_str()) {
                    encoding.insert(index as u32, i as i64);
                }
            }
            return Ok(CffEncoding { predefined: true, format: pos as u8, encoding });
        }
        let data_start = pos;
        let mut pos = pos;
        let format_byte = self.get(pos);
        pos += 1;
        let format = format_byte.unwrap_or(0);
        match format & 0x7f {
            0 => {
                let glyphs_count = self.get(pos);
                pos += 1;
                for i in 1..=i64::from(glyphs_count.unwrap_or(0)) {
                    if let Some(code) = self.get(pos) {
                        encoding.insert(u32::from(code), i);
                    }
                    pos += 1;
                }
            }
            1 => {
                let ranges_count = self.get(pos);
                pos += 1;
                let mut gid = 1;
                for _ in 0..ranges_count.unwrap_or(0) {
                    let start = self.get(pos);
                    pos += 1;
                    let left = self.get(pos);
                    pos += 1;
                    if let (Some(start), Some(left)) = (start, left) {
                        for j in u32::from(start)..=u32::from(start) + u32::from(left) {
                            encoding.insert(j, gid);
                            gid += 1;
                        }
                    }
                }
            }
            _ => {
                return Err(PdfError::Format(format!(
                    "Unknown encoding format: {} in CFF",
                    format_byte.map_or_else(|| "undefined".to_owned(), |f| f.to_string())
                )));
            }
        }
        if format & 0x80 != 0 {
            if let Ok(at) = usize::try_from(data_start)
                && let Some(byte) = self.bytes.get_mut(at)
            {
                *byte &= 0x7f;
            }
            let supplements_count = self.get(pos);
            pos += 1;
            for _ in 0..supplements_count.unwrap_or(0) {
                let code = self.get(pos);
                pos += 1;
                let sid = (self.at(pos) << 8) + (self.at(pos + 1) & 0xff);
                pos += 2;
                if let Some(code) = code {
                    let name = strings.get(i64::from(sid));
                    let index = charset.iter().position(|e| matches!(e, CharsetEntry::Name(n) if *n == name)).map_or(-1, |p| p as i64);
                    encoding.insert(u32::from(code), index);
                }
            }
        }
        Ok(CffEncoding { predefined: false, format: format & 0x7f, encoding })
    }

    fn parse_fd_select(&self, pos: i64, length: usize) -> Result<CffFdSelect> {
        let mut pos = pos;
        let format = self.get(pos);
        pos += 1;
        let mut fd_select: Vec<Option<u8>> = Vec::new();
        match format {
            Some(0) => {
                for _ in 0..length {
                    fd_select.push(self.get(pos));
                    pos += 1;
                }
            }
            Some(3) => {
                let ranges_count = self.u16_at(pos);
                pos += 2;
                for i in 0..ranges_count {
                    let mut first = i64::from(self.u16_at(pos));
                    pos += 2;
                    if i == 0 && first != 0 {
                        tracing::warn!("parseFDSelect: The first range must have a first GID of 0 -- trying to recover.");
                        first = 0;
                    }
                    let fd_index = self.get(pos);
                    pos += 1;
                    let next = i64::from(self.u16_at(pos));
                    if next - first > length as i64 - fd_select.len() as i64 {
                        return Err(PdfError::Format("parseFDSelect: Invalid font data.".to_owned()));
                    }
                    for _ in first..next {
                        fd_select.push(fd_index);
                    }
                }
            }
            _ => {
                return Err(PdfError::Format(format!(
                    "parseFDSelect: Unknown format \"{}\".",
                    format.map_or_else(|| "undefined".to_owned(), |f| f.to_string())
                )));
            }
        }
        if fd_select.len() != length {
            return Err(PdfError::Format("parseFDSelect: Invalid font data.".to_owned()));
        }
        Ok(CffFdSelect { format: format.unwrap_or(0), fd_select })
    }
}

/// `createDict`.
fn create_dict(layout: &'static [Layout], entries: Vec<(u16, Vec<f64>)>) -> CffDict {
    let mut dict = CffDict::new(layout);
    for (key, value) in entries {
        dict.set_by_key(key, value);
    }
    dict
}

fn looks_like_unsigned_16_bit_negative(coord: f64) -> bool {
    coord > 32767.0 && coord <= 65535.0
}

/// `recoverSigned16BitBBox` (with `Util.normalizeRect`).
fn recover_signed_16_bit_bbox(bbox: &[f64], only_lower_left: bool) -> Vec<f64> {
    let mapped: Vec<f64> = bbox
        .iter()
        .enumerate()
        .map(|(i, &coord)| if (!only_lower_left || i < 2) && looks_like_unsigned_16_bit_negative(coord) { coord - 65536.0 } else { coord })
        .collect();
    // A missing coordinate is `undefined` in pdf.js and never compares greater.
    let mut r = mapped.clone();
    if mapped.len() > 2 && mapped[0] > mapped[2] {
        r[0] = mapped[2];
        r[2] = mapped[0];
    }
    if mapped.len() > 3 && mapped[1] > mapped[3] {
        r[1] = mapped[3];
        r[3] = mapped[1];
    }
    r
}

fn is_array_equal(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x == y)
}
