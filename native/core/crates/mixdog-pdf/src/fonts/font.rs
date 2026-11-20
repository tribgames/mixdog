//! The font object, ported from pdf.js 6.4.299: `PartialEvaluator.loadFont`, `preEvaluateFont`, `translateFont` and
//! `TranslatedFont` of `src/core/evaluator.js`, and `Font`, `ErrorFont` and `Glyph` of `src/core/fonts.js`, as far as
//! they decide what `getTextContent` reads from a font: which glyphs a string of character codes is, the text of each,
//! its width (and vertical metrics), the font's matrix, box, ascent and descent, and whether the font is vertical.
//!
//! What pdf.js builds for drawing is not here: the repaired font file, the glyph outlines, `fontChar` and the
//! accent of a `seac` glyph. The font programs are still read (`fontfile`), because pdf.js's verdict on them decides
//! the font: a program that cannot be read makes the font a missing-file font, whose text comes from the encoding
//! instead of the program's `cmap`, and the program's own encoding and `name` table amend the ToUnicode map.
//!
//! Reference configuration (`useSystemFonts` true): the program of a non-embedded font is only ever the one of Symbol
//! and ZapfDingbats; any other non-embedded font is a missing-file font named by the standard-font maps and measured by
//! the Standard 14 metrics. The predefined CMaps are the embedded ones.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::data::{
    self, CharCategory,
    encodings::{STANDARD_ENCODING, SYMBOL_GLYPH_ID_ENCODING, SYMBOL_SET_ENCODING, WIN_ANSI_ENCODING, ZAPF_DINGBATS_ENCODING},
    font_flags,
    glyphlist::{DINGBATS_GLYPHS_UNICODE, GLYPHS_UNICODE},
    standard_fonts::{
        GLYPH_MAP_FOR_MAC_ORDERED_FONTS, GLYPH_MAP_FOR_STANDARD_FONTS, NON_STD_FONT_MAP, SERIF_FONTS, STD_FONT_MAP, SUPPLEMENTAL_GLYPH_MAP_FOR_ARIAL_BLACK,
        SUPPLEMENTAL_GLYPH_MAP_FOR_CALIBRI, SUPPLEMENTAL_GLYPH_MAP_FOR_TREBUCHET_MS, SYMBOLS_FONTS,
    },
    unicode::VERTICAL_PRESENTATION_FORM,
};
use super::to_unicode::{ToUnicode, ToUnicodeMap, UniValue, extract_data_structures, from_char_code};
use super::widths::{build_char_code_to_width, extract_widths, get_base_font_metrics, get_standard_font_name, is_integer, is_serif_font, normalize_font_name};
use crate::error::{PdfError, Result};
use crate::fontfile::cff::{CffProperties, js_to_int32, read_cff_font, standard_font_data};
use crate::fontfile::cmap::{CMap, CMapEncoding, CMapFactory, CMapValue};
use crate::fontfile::truetype::{NameRecord, TrueTypeFont};
use crate::fontfile::type1::{Type1Font, Type1Properties};
use crate::object::{Dict, Obj, Ref};
use crate::stream::PdfStream;
use crate::xref::Xref;

/// `FONT_IDENTITY_MATRIX`.
pub const FONT_IDENTITY_MATRIX: [f64; 6] = [0.001, 0.0, 0.0, 0.001, 0.0, 0.0];
/// `PDF_GLYPH_SPACE_UNITS`.
pub const PDF_GLYPH_SPACE_UNITS: f64 = 1000.0;
/// The loaded name of a font that failed before it got one (`g_font_error`).
pub const ERROR_FONT_NAME: &str = "g_font_error";

/// A base encoding: the glyph name of each code 0 to 255.
pub type Encoding = &'static [&'static str; 256];

/// The `ascent`, `descent` and `capHeight` pdf.js knows for the Standard 14 (`getFontBasicMetrics`), by name.
static FONT_BASIC_METRICS: [(&str, [f64; 3]); 14] = [
    ("Courier", [629.0, -157.0, 562.0]),
    ("Courier-Bold", [629.0, -157.0, 562.0]),
    ("Courier-BoldOblique", [629.0, -157.0, 562.0]),
    ("Courier-Oblique", [629.0, -157.0, 562.0]),
    ("Helvetica", [718.0, -207.0, 718.0]),
    ("Helvetica-Bold", [718.0, -207.0, 718.0]),
    ("Helvetica-BoldOblique", [718.0, -207.0, 718.0]),
    ("Helvetica-Oblique", [718.0, -207.0, 718.0]),
    ("Symbol", [f64::NAN, f64::NAN, f64::NAN]),
    ("Times-Bold", [683.0, -217.0, 676.0]),
    ("Times-BoldItalic", [683.0, -217.0, 669.0]),
    ("Times-Italic", [683.0, -217.0, 653.0]),
    ("Times-Roman", [683.0, -217.0, 662.0]),
    ("ZapfDingbats", [f64::NAN, f64::NAN, f64::NAN]),
];

// ---- the font's encoding differences and properties ----------------------------------------------------------------

/// The `Differences` of a font's encoding: a `Map` from code (a number, not always an integer) to glyph name, in the
/// order the entries were added.
#[derive(Debug, Clone, Default)]
pub struct Differences {
    entries: Vec<(f64, String)>,
    by_code: HashMap<i64, usize>,
}

impl Differences {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Map.set(key, name)`.
    pub fn set(&mut self, key: f64, name: String) {
        let at = self.entries.iter().position(|(code, _)| *code == key);
        match at {
            Some(at) => self.entries[at].1 = name,
            None => {
                if is_integer(key) {
                    self.by_code.insert(key as i64, self.entries.len());
                }
                self.entries.push((key, name));
            }
        }
    }

    /// `Map.get(code)`.
    pub fn get(&self, code: i64) -> Option<&str> {
        self.by_code.get(&code).map(|&at| self.entries[at].1.as_str())
    }

    pub fn has(&self, code: i64) -> bool {
        self.by_code.contains_key(&code)
    }

    /// `size`.
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// The entries in the order they were added.
    pub fn iter(&self) -> impl Iterator<Item = (f64, &str)> {
        self.entries.iter().map(|(code, name)| (*code, name.as_str()))
    }
}

/// `CIDSystemInfo`.
#[derive(Debug, Clone)]
pub struct CidSystemInfo {
    pub registry: String,
    pub ordering: String,
}

/// What `translateFont` collects about a font before the `Font` is made (pdf.js's `properties`).
#[derive(Debug, Clone)]
pub struct Properties {
    /// The font's `/Subtype` (of the descendant font for a Type0 font).
    pub ty: String,
    /// The `/Subtype` of the font file's stream.
    pub subtype: Option<String>,
    pub name: String,
    pub loaded_name: String,
    /// Whether there is a font program, an embedded one or the program of Symbol or ZapfDingbats.
    pub has_file: bool,
    /// `FontFile`, `FontFile2` or `FontFile3`.
    pub font_file_n: Option<&'static str>,
    pub length1: Option<f64>,
    /// The font program is the bundled one of Symbol or ZapfDingbats.
    pub is_internal_font: bool,
    pub is_simulated_flags: bool,
    pub composite: bool,
    pub font_matrix: Option<[f64; 6]>,
    pub first_char: i64,
    pub last_char: i64,
    /// The `/ToUnicode` entry as the file has it (a name or a stream).
    pub to_unicode_obj: Obj,
    pub to_unicode: Option<ToUnicode>,
    pub bbox: Option<[f64; 4]>,
    /// `NaN` where the descriptor has none (`undefined` in pdf.js).
    pub ascent: f64,
    pub descent: f64,
    pub x_height: f64,
    pub cap_height: f64,
    pub flags: i32,
    pub italic_angle: f64,
    pub is_type3: bool,
    pub cid_encoding: Option<String>,
    pub cmap: Option<CMap>,
    pub vertical: bool,
    pub default_encoding: Encoding,
    pub differences: Differences,
    pub base_encoding_name: Option<String>,
    pub has_encoding: bool,
    pub cid_system_info: Option<CidSystemInfo>,
    pub cid_to_gid_map: Option<BTreeMap<u32, u32>>,
    pub has_included_to_unicode_map: bool,
    pub fallback_to_unicode: Option<ToUnicodeMap>,
    pub widths: BTreeMap<i64, f64>,
    pub default_width: f64,
    pub vmetrics: BTreeMap<i64, [f64; 3]>,
    pub default_vmetrics: Option<[f64; 3]>,
    /// The encoding of the font program (`builtInEncoding`): code to glyph name.
    pub built_in_encoding: Option<BTreeMap<u32, String>>,
}

impl Default for Properties {
    fn default() -> Self {
        Properties {
            ty: String::new(),
            subtype: None,
            name: String::new(),
            loaded_name: String::new(),
            has_file: false,
            font_file_n: None,
            length1: None,
            is_internal_font: false,
            is_simulated_flags: false,
            composite: false,
            font_matrix: None,
            first_char: 0,
            last_char: 0xff,
            to_unicode_obj: Obj::Null,
            to_unicode: None,
            bbox: None,
            ascent: f64::NAN,
            descent: f64::NAN,
            x_height: 0.0,
            cap_height: 0.0,
            flags: 0,
            italic_angle: 0.0,
            is_type3: false,
            cid_encoding: None,
            cmap: None,
            vertical: false,
            default_encoding: &STANDARD_ENCODING,
            differences: Differences::new(),
            base_encoding_name: None,
            has_encoding: false,
            cid_system_info: None,
            cid_to_gid_map: None,
            has_included_to_unicode_map: false,
            fallback_to_unicode: None,
            widths: BTreeMap::new(),
            default_width: 0.0,
            vmetrics: BTreeMap::new(),
            default_vmetrics: None,
            built_in_encoding: None,
        }
    }
}

// ---- MurmurHash3_64 ------------------------------------------------------------------------------------------------

/// pdf.js's `MurmurHash3_64`, computed with the same JavaScript number arithmetic (the products overflow 2^53 and lose
/// their low bits, which the hash depends on). It names the fonts that share a descriptor and an encoding.
struct MurmurHash {
    h1: f64,
    h2: f64,
}

const MURMUR_SEED: f64 = 3_285_377_520.0;
const MASK_HIGH: i32 = -65_536;
const MASK_LOW: i32 = 0xffff;

fn to_i32(value: f64) -> i32 {
    js_to_int32(value)
}

fn to_u32(value: f64) -> u32 {
    js_to_int32(value) as u32
}

/// `x * c & MASK_HIGH | x * cLow & MASK_LOW`.
fn mul_parts(x: f64, c: f64, c_low: f64) -> i32 {
    (to_i32(x * c) & MASK_HIGH) | (to_i32(x * c_low) & MASK_LOW)
}

fn rotl15(k: i32) -> i32 {
    (k << 15) | ((k as u32) >> 17) as i32
}

fn mix_k(block: f64) -> i32 {
    const C1: f64 = 3_432_918_353.0;
    const C1_LOW: f64 = 0x2d51 as f64;
    const C2: f64 = 461_845_907.0;
    const C2_LOW: f64 = 0x3593 as f64;
    let k = mul_parts(block, C1, C1_LOW);
    let k = rotl15(k);
    mul_parts(f64::from(k), C2, C2_LOW)
}

impl MurmurHash {
    fn new() -> Self {
        MurmurHash { h1: MURMUR_SEED, h2: MURMUR_SEED }
    }

    /// `update(string)`: a character above 0xff contributes its two bytes.
    fn update_str(&mut self, text: &str) {
        let mut data = Vec::with_capacity(text.len() * 2);
        for ch in text.chars() {
            let code = ch as u32;
            if code <= 0xff {
                data.push(code as u8);
            } else {
                data.push((code >> 8) as u8);
                data.push((code & 0xff) as u8);
            }
        }
        self.update(&data);
    }

    /// `update(Uint8Array)`.
    fn update(&mut self, data: &[u8]) {
        let block_counts = data.len() >> 2;
        let mut h1 = self.h1;
        let mut h2 = self.h2;
        for (i, bytes) in data.chunks_exact(4).enumerate() {
            let block = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            let k = mix_k(f64::from(block));
            let h = if i & 1 == 1 { &mut h1 } else { &mut h2 };
            let mixed = to_i32(*h) ^ k;
            let rotated = (mixed << 13) | ((mixed as u32) >> 19) as i32;
            *h = f64::from(rotated) * 5.0 + 3_864_292_196.0;
        }
        let tail = &data[block_counts * 4..];
        if !tail.is_empty() {
            let mut k1: i32 = 0;
            if tail.len() >= 3 {
                k1 ^= i32::from(tail[2]) << 16;
            }
            if tail.len() >= 2 {
                k1 ^= i32::from(tail[1]) << 8;
            }
            k1 ^= i32::from(tail[0]);
            let k1 = mix_k(f64::from(k1));
            if block_counts & 1 == 1 {
                h1 = f64::from(to_i32(h1) ^ k1);
            } else {
                h2 = f64::from(to_i32(h2) ^ k1);
            }
        }
        self.h1 = h1;
        self.h2 = h2;
    }

    fn hexdigest(&self) -> String {
        /// `(x * c & MASK_HIGH) >>> 16` of an int32 `x`.
        fn high_shr16(x: i32, c: f64) -> i32 {
            (((to_i32(f64::from(x) * c) & MASK_HIGH) as u32) >> 16) as i32
        }
        let mut h1 = self.h1;
        let mut h2 = self.h2;
        h1 = f64::from(to_i32(h1) ^ (to_u32(h2) >> 1) as i32);
        h1 = f64::from(mul_parts(h1, f64::from(0xed55_8ccd_u32), f64::from(0x8ccd_u32)));
        let mixed = (to_i32(h2) << 16) | (to_u32(h1) >> 16) as i32;
        h2 = f64::from((to_i32(h2 * f64::from(0xff51_afd7_u32)) & MASK_HIGH) | high_shr16(mixed, f64::from(0xafd7_ed55_u32)));
        h1 = f64::from(to_i32(h1) ^ (to_u32(h2) >> 1) as i32);
        h1 = f64::from(mul_parts(h1, f64::from(0x1a85_ec53_u32), f64::from(0xec53_u32)));
        let mixed = (to_i32(h2) << 16) | (to_u32(h1) >> 16) as i32;
        h2 = f64::from((to_i32(h2 * f64::from(0xc4ce_b9fe_u32)) & MASK_HIGH) | high_shr16(mixed, f64::from(0xb9fe_1a85_u32)));
        h1 = f64::from(to_i32(h1) ^ (to_u32(h2) >> 1) as i32);
        format!("{:08x}{:08x}", to_u32(h1), to_u32(h2))
    }
}

// ---- glyphs and fonts ----------------------------------------------------------------------------------------------

/// One glyph of a string (`Glyph`), as far as the text of a page reads it.
#[derive(Debug, Clone)]
pub struct Glyph {
    pub original_char_code: u32,
    /// The glyph's text as UTF-16 code units (`unicode`).
    pub unicode: Vec<u16>,
    pub width: f64,
    /// `vmetric` of a vertical font: the vertical advance, then the position vector.
    pub vmetric: Option<[f64; 3]>,
    pub is_space: bool,
}

impl Glyph {
    /// `category`: whether the text is white space, a zero-width diacritic or an invisible format mark.
    pub fn category(&self) -> CharCategory {
        data::get_char_unicode_category(&String::from_utf16_lossy(&self.unicode))
    }
}

/// The part of `/Differences` and base encoding that names a glyph for a code: pdf.js's
/// `differences.get(code) || defaultEncoding[code]`.
fn glyph_name_of(differences: &Differences, encoding: Encoding, code: i64) -> Option<&str> {
    match differences.get(code) {
        Some(name) if !name.is_empty() => Some(name),
        _ => usize::try_from(code).ok().and_then(|code| encoding.get(code)).copied(),
    }
}

/// `buildToFontChar(encoding, glyphsUnicodeMap, differences)`.
fn build_to_font_char(encoding: &[&str], glyphs: &[(&str, u32)], differences: &Differences) -> ToUnicodeMap {
    let mut map = ToUnicodeMap::new();
    for (code, glyph_name) in encoding.iter().enumerate() {
        if let Some(unicode) = data::get_unicode_for_glyph(glyph_name, glyphs) {
            map.set(code as u32, UniValue::Code(i64::from(unicode)));
        }
    }
    for (code, glyph_name) in differences.iter() {
        if is_integer(code)
            && (0.0..=f64::from(u32::MAX)).contains(&code)
            && let Some(unicode) = data::get_unicode_for_glyph(glyph_name, glyphs)
        {
            map.set(code as u32, UniValue::Code(i64::from(unicode)));
        }
    }
    map
}

/// `applyStandardFontGlyphMap(map, glyphMap)`.
fn apply_standard_font_glyph_map(map: &mut ToUnicodeMap, glyph_map: &[(u32, u32)]) {
    for &(code, value) in glyph_map {
        map.set(code, UniValue::Code(i64::from(value)));
    }
}

/// `convertCidString(charCode, cid, shouldThrow)` of a CMap string value: the CID of a one or two byte string. `None`
/// is the string pdf.js keeps (and finds no width for) when it is longer.
fn convert_cid_string(char_code: u32, cid: &[u16], should_throw: bool) -> Result<Option<i64>> {
    match cid {
        [one] => Ok(Some(i64::from(*one))),
        [high, low] => Ok(Some(i64::from(*high) << 8 | i64::from(*low))),
        _ => {
            let message = format!("Unsupported CID string (charCode {char_code}): \"{}\".", String::from_utf16_lossy(cid));
            if should_throw {
                return Err(PdfError::format(message));
            }
            tracing::warn!("{message}");
            Ok(None)
        }
    }
}

/// `new Font(name, file, properties)` as far as the text of a page reads it.
#[derive(Debug)]
pub struct Font {
    pub name: String,
    /// `loadedName`: the name pdf.js gave the font; a missing-file font ends with the first part of its name.
    pub loaded_name: String,
    pub is_type3_font: bool,
    pub missing_file: bool,
    pub ty: String,
    pub subtype: Option<String>,
    pub is_serif_font: bool,
    pub is_symbolic_font: bool,
    pub is_monospace: bool,
    /// `fallbackName`: the `fontFamily` of the style of the font's text items.
    pub fallback_name: String,
    pub differences: Differences,
    pub widths: BTreeMap<i64, f64>,
    pub default_width: f64,
    pub composite: bool,
    pub cmap: Option<CMap>,
    pub cap_height: f64,
    /// `NaN` where neither the font nor the standard metrics have one.
    pub ascent: f64,
    pub descent: f64,
    pub line_height: f64,
    pub font_matrix: Option<[f64; 6]>,
    pub bbox: Option<[f64; 4]>,
    /// A Type 3 font whose glyph descriptions gave the font a bounding box (`isCharBBox`).
    pub is_char_bbox: bool,
    pub default_encoding: Encoding,
    pub to_unicode: ToUnicode,
    pub cid_encoding: String,
    pub vertical: bool,
    pub vmetrics: BTreeMap<i64, [f64; 3]>,
    pub default_vmetrics: Option<[f64; 3]>,
    /// The code to character map of a missing-file font (`toFontChar`).
    to_font_char: ToUnicodeMap,
    /// The font program that was read (embedded, or the bundled one of Symbol and ZapfDingbats): what drawing needs of
    /// a font pdf.js rebuilds into its own file. `None` for a font without a usable program.
    pub program: Option<Arc<Vec<u8>>>,
    pub is_internal_font: bool,
    /// The encoding of the font program (`builtInEncoding`): code to glyph name.
    pub built_in_encoding: Option<BTreeMap<u32, String>>,
    /// `cidToGidMap` of a CID font that has a `CIDToGIDMap` stream.
    pub cid_to_gid_map: Option<BTreeMap<u32, u32>>,
    pub has_encoding: bool,
    pub base_encoding_name: Option<String>,
    pub has_included_to_unicode_map: bool,
    /// The `Flags` of the descriptor (as the font leaves them) and its `ItalicAngle`.
    pub flags: i32,
    pub italic_angle: f64,
    space_width: OnceLock<f64>,
    glyph_cache: Mutex<HashMap<u32, Arc<Glyph>>>,
    chars_cache: CharsCache,
}

type CharsCache = Mutex<HashMap<Vec<u8>, Vec<Arc<Glyph>>>>;

/// `getFontFileType(file, properties)`: the type and subtype the bytes of a font file say.
fn get_font_file_type(file: &[u8], properties: &Properties) -> (String, Option<String>) {
    let header = &file[..file.len().min(4)];
    let ty = properties.ty.as_str();
    let composite = properties.composite;
    if header == [0, 1, 0, 0] || header == b"true" || header == b"ttcf" {
        let file_type = if composite { "CIDFontType2" } else { "TrueType" };
        (file_type.to_owned(), None)
    } else if header == b"OTTO" {
        let file_type = if composite { "CIDFontType2" } else { "OpenType" };
        (file_type.to_owned(), None)
    } else if header.starts_with(&[0x25, 0x21]) || header.starts_with(&[0x80, 0x01]) {
        let file_type = if composite {
            "CIDFontType0"
        } else if ty == "MMType1" {
            "MMType1"
        } else {
            "Type1"
        };
        (file_type.to_owned(), None)
    } else if header.len() == 4 && header[0] >= 1 && header[3] >= 1 && header[3] <= 4 {
        if composite {
            ("CIDFontType0".to_owned(), Some("CIDFontType0C".to_owned()))
        } else {
            let file_type = if ty == "MMType1" { "MMType1" } else { "Type1" };
            (file_type.to_owned(), Some("Type1C".to_owned()))
        }
    } else {
        tracing::warn!("getFontFileType: Unable to detect correct font file Type/Subtype.");
        (ty.to_owned(), properties.subtype.clone())
    }
}

/// `adjustWidths(properties)`: the widths of a font whose matrix is not the usual one, in thousandths.
fn adjust_widths(properties: &mut Properties) {
    let Some(matrix) = properties.font_matrix else {
        return;
    };
    if matrix[0] == FONT_IDENTITY_MATRIX[0] {
        return;
    }
    let scale = 0.001 / matrix[0];
    for width in properties.widths.values_mut() {
        *width *= scale;
    }
    properties.default_width *= scale;
}

/// A font matrix of the program (a JavaScript array of any length) as six numbers; what is missing is `NaN`.
fn matrix_of(values: &[f64]) -> [f64; 6] {
    let mut matrix = [f64::NAN; 6];
    for (slot, value) in matrix.iter_mut().zip(values) {
        *slot = *value;
    }
    matrix
}

fn same_as_encoding(map: &BTreeMap<u32, String>, table: Encoding) -> bool {
    map.len() == table.len() && map.iter().all(|(code, name)| table.get(*code as usize).is_some_and(|glyph| glyph == name))
}

impl Font {
    /// `new Font(name, file, properties)`. `file` is the decoded font program, `None` for a font without one. A
    /// program pdf.js cannot read makes the font a missing-file font.
    pub fn new(name: &str, file: Option<&[u8]>, mut properties: Properties) -> Result<Font> {
        let mut is_serif_font = properties.flags & font_flags::SERIF as i32 != 0;
        if !is_serif_font && !properties.is_simulated_flags {
            for name_part in name.split('+') {
                let normalized = normalize_font_name(name_part);
                let font_name =
                    data::lookup(&STD_FONT_MAP, &normalized).or_else(|| data::lookup(&NON_STD_FONT_MAP, &normalized)).map_or(normalized.clone(), str::to_owned);
                let family = font_name.split('-').next().unwrap_or("");
                if data::contains_name(&SERIF_FONTS, family) {
                    is_serif_font = true;
                    break;
                }
            }
        }
        let is_monospace = properties.flags & font_flags::FIXED_PITCH as i32 != 0;
        let fallback_name = if let Some(name) = invalid_pdfjs_font_name(name) {
            name.to_owned()
        } else if is_monospace {
            "monospace".to_owned()
        } else if is_serif_font {
            "serif".to_owned()
        } else {
            "sans-serif".to_owned()
        };
        let to_unicode = properties.to_unicode.take().ok_or_else(|| PdfError::Unknown("Cannot read properties of undefined (reading 'size')".to_owned()))?;
        let ascent = properties.ascent / PDF_GLYPH_SPACE_UNITS;
        let descent = properties.descent / PDF_GLYPH_SPACE_UNITS;
        let mut font = Font {
            name: name.to_owned(),
            loaded_name: properties.loaded_name.clone(),
            is_type3_font: properties.is_type3,
            missing_file: false,
            ty: properties.ty.clone(),
            subtype: properties.subtype.clone(),
            is_serif_font,
            is_symbolic_font: properties.flags & font_flags::SYMBOLIC as i32 != 0,
            is_monospace,
            fallback_name,
            differences: properties.differences.clone(),
            widths: properties.widths.clone(),
            default_width: properties.default_width,
            composite: properties.composite,
            cmap: properties.cmap.clone(),
            cap_height: properties.cap_height / PDF_GLYPH_SPACE_UNITS,
            ascent,
            descent,
            line_height: ascent - descent,
            font_matrix: properties.font_matrix,
            bbox: properties.bbox,
            is_char_bbox: false,
            default_encoding: properties.default_encoding,
            to_unicode,
            cid_encoding: String::new(),
            vertical: false,
            vmetrics: BTreeMap::new(),
            default_vmetrics: None,
            to_font_char: ToUnicodeMap::new(),
            program: None,
            is_internal_font: properties.is_internal_font,
            built_in_encoding: None,
            cid_to_gid_map: properties.cid_to_gid_map.clone(),
            has_encoding: properties.has_encoding,
            base_encoding_name: properties.base_encoding_name.clone(),
            has_included_to_unicode_map: properties.has_included_to_unicode_map,
            flags: properties.flags,
            italic_angle: properties.italic_angle,
            space_width: OnceLock::new(),
            glyph_cache: Mutex::new(HashMap::new()),
            chars_cache: Mutex::new(HashMap::new()),
        };
        if properties.ty == "Type3" {
            return Ok(font);
        }
        font.cid_encoding = properties.cid_encoding.clone().unwrap_or_default();
        font.vertical = properties.vertical;
        if font.vertical {
            font.vmetrics = properties.vmetrics.clone();
            font.default_vmetrics = properties.default_vmetrics;
        }
        let Some(file) = file.filter(|bytes| !bytes.is_empty()) else {
            font.fallback_to_system_font(&properties)?;
            return Ok(font);
        };
        let (file_type, file_subtype) = get_font_file_type(file, &properties);
        if file_type != font.ty || file_subtype != font.subtype {
            tracing::info!(
                "Inconsistent font file Type/SubType, expected: {}/{} but found: {}/{}.",
                font.ty,
                font.subtype.as_deref().unwrap_or("undefined"),
                file_type,
                file_subtype.as_deref().unwrap_or("undefined")
            );
        }
        match font.read_font_program(file, &file_type, file_subtype.as_deref(), &mut properties) {
            Ok(()) => {}
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => {
                tracing::warn!("{error}");
                // The widths are one array in pdf.js: what the program's reader did to it is seen by the font.
                font.widths = properties.widths.clone();
                font.fallback_to_system_font(&properties)?;
                return Ok(font);
            }
        }
        font.amend_fallback_to_unicode(&properties);
        font.program = Some(Arc::new(file.to_vec()));
        font.built_in_encoding = properties.built_in_encoding.clone();
        font.ty = file_type;
        font.subtype = file_subtype;
        font.font_matrix = properties.font_matrix;
        font.widths = properties.widths;
        font.default_width = properties.default_width;
        Ok(font)
    }

    /// The `switch (type)` of the `Font` constructor: reads the program and applies what it says to the ToUnicode
    /// map and the widths. An error means pdf.js's verdict is that the font program is not usable.
    fn read_font_program(&mut self, file: &[u8], file_type: &str, file_subtype: Option<&str>, properties: &mut Properties) -> Result<()> {
        match file_type {
            "MMType1" | "Type1" | "CIDFontType0" => {
                if file_subtype == Some("Type1C") || file_subtype == Some("CIDFontType0C") {
                    read_cff_program(file, properties)?;
                } else {
                    read_type1_program(file, properties)?;
                }
                adjust_widths(properties);
                self.convert(properties);
                Ok(())
            }
            "OpenType" | "TrueType" | "CIDFontType2" => {
                self.check_and_repair(file, properties)?;
                adjust_widths(properties);
                Ok(())
            }
            other => Err(PdfError::format(format!("Font {other} is not supported"))),
        }
    }

    /// `convert(fontName, font, properties)`: what it does to the text mapping. The font file pdf.js assembles from
    /// the program, the glyph map and the `seac` accents serve drawing only.
    fn convert(&mut self, properties: &Properties) {
        if let Some(built_in) = &properties.built_in_encoding {
            self.adjust_type1_to_unicode(properties, built_in);
        }
    }

    /// `adjustType1ToUnicode(properties, builtInEncoding)`: the text of the codes the font program's own encoding
    /// names, when the file says nothing about them.
    fn adjust_type1_to_unicode(&mut self, properties: &Properties, built_in_encoding: &BTreeMap<u32, String>) {
        if properties.is_internal_font
            || properties.has_included_to_unicode_map
            || same_as_encoding(built_in_encoding, properties.default_encoding)
            || self.to_unicode.is_identity()
        {
            return;
        }
        let mut to_unicode = ToUnicodeMap::new();
        for (code, glyph_name) in built_in_encoding {
            if properties.has_encoding && (properties.base_encoding_name.is_some() || properties.differences.has(i64::from(*code))) {
                continue;
            }
            if let Some(unicode) = data::get_unicode_for_glyph(glyph_name, &GLYPHS_UNICODE) {
                to_unicode.set(*code, UniValue::Str(from_char_code(i64::from(unicode))));
            }
        }
        self.to_unicode.amend(&to_unicode);
    }

    /// `adjustTrueTypeToUnicode(properties, isSymbolicFont, nameRecords)`: a symbolic TrueType font without an encoding
    /// whose names are all Windows names is read as WinAnsi.
    fn adjust_true_type_to_unicode(&mut self, properties: &Properties, name_records: &[NameRecord]) {
        if properties.is_internal_font
            || properties.has_included_to_unicode_map
            || properties.has_encoding
            || self.to_unicode.is_identity()
            || !self.is_symbolic_font
            || name_records.is_empty()
            || std::ptr::eq(properties.default_encoding, &WIN_ANSI_ENCODING)
            || !name_records.iter().all(NameRecord::is_win)
        {
            return;
        }
        let mut to_unicode = ToUnicodeMap::new();
        for (code, glyph_name) in WIN_ANSI_ENCODING.iter().enumerate() {
            if glyph_name.is_empty() {
                continue;
            }
            if let Some(unicode) = data::glyph_unicode(glyph_name) {
                to_unicode.set(code as u32, UniValue::Str(from_char_code(i64::from(unicode))));
            }
        }
        self.to_unicode.amend(&to_unicode);
    }

    /// `amendFallbackToUnicode(properties)`: the codes the file's map misses get the text of the encoding.
    fn amend_fallback_to_unicode(&mut self, properties: &Properties) {
        let Some(fallback) = &properties.fallback_to_unicode else {
            return;
        };
        if self.to_unicode.is_identity() {
            return;
        }
        let mut missing = ToUnicodeMap::new();
        for (code, value) in fallback.iter() {
            if !self.to_unicode.has(code) {
                missing.set(code, value.clone());
            }
        }
        self.to_unicode.amend(&missing);
    }

    /// The reading of an OpenType or TrueType program in `checkAndRepair`: everything that can make pdf.js refuse the
    /// font, `ascent` and `descent` of the `hhea` table, and the ToUnicode amendment of the `name` table.
    fn check_and_repair(&mut self, file: &[u8], properties: &mut Properties) -> Result<()> {
        let ttf = TrueTypeFont::parse(file, &self.name)?;
        let is_true_type = ttf.is_true_type();
        let mut num_glyphs_from_cff = None;
        if !is_true_type {
            let cff_data = ttf.table_data("CFF ").ok_or_else(|| PdfError::format("Required \"CFF \" table is not found"))?;
            let mut cff_properties = cff_properties_of(properties);
            let parsed = match read_cff_font(cff_data, &mut cff_properties) {
                Ok(cff) => {
                    if let Some(matrix) = &cff_properties.font_matrix {
                        properties.font_matrix = Some(matrix_of(matrix));
                    }
                    Some(cff)
                }
                Err(_) => {
                    tracing::warn!("Failed to parse font {}", properties.loaded_name);
                    None
                }
            };
            let is_cid_font = parsed.as_ref().is_some_and(|cff| cff.is_cid_font);
            let opentype_cff = ttf.header_version() == "OTTO" && (!properties.composite || (properties.font_file_n == Some("FontFile3") && is_cid_font));
            if opentype_cff || ["head", "hhea", "maxp", "post"].iter().any(|tag| ttf.table(tag).is_none()) {
                read_cff_program(cff_data, properties)?;
                self.convert(properties);
                return Ok(());
            }
            num_glyphs_from_cff = parsed.map(|cff| cff.char_string_count as i32);
        }
        ttf.glyph_info(num_glyphs_from_cff)?;
        let metrics = ttf.metrics_override()?;
        self.ascent = metrics.ascent_ratio();
        self.descent = metrics.descent_ratio();
        self.line_height = self.ascent - self.descent + metrics.line_gap_ratio();
        if properties.composite {
            if let Some(cmap) = &properties.cmap {
                let mut failure = None;
                cmap.for_each(|char_code, value| {
                    if failure.is_some() {
                        return;
                    }
                    let cid = match value {
                        CMapValue::Cid(cid) => Some(*cid),
                        CMapValue::Str(text) => match convert_cid_string(char_code, text, true) {
                            Ok(cid) => cid,
                            Err(error) => {
                                failure = Some(error);
                                return;
                            }
                        },
                        CMapValue::Other => None,
                    };
                    if cid.is_some_and(|cid| cid > 0xffff) {
                        failure = Some(PdfError::format("Max size of CID is 65,535"));
                    }
                });
                if let Some(error) = failure {
                    return Err(error);
                }
            }
        } else {
            ttf.read_cmap_table(self.is_symbolic_font, properties.has_encoding)?;
        }
        if let Some(name_table) = ttf.read_name_table()
            && !properties.composite
        {
            self.adjust_true_type_to_unicode(properties, &name_table.records);
        }
        Ok(())
    }

    /// `fallbackToSystemFont(properties)`: a font without a usable program. Its text comes from the encoding (or from
    /// the ToUnicode map), its metrics from the Standard 14 when it is one.
    fn fallback_to_system_font(&mut self, properties: &Properties) -> Result<()> {
        self.missing_file = true;
        let normalized = normalize_font_name(&self.name);
        let standard = data::lookup(&STD_FONT_MAP, &normalized);
        let is_standard_font = standard.is_some();
        let non_standard = data::lookup(&NON_STD_FONT_MAP, &normalized);
        let is_mapped_to_standard = non_standard.is_some_and(|mapped| data::lookup(&STD_FONT_MAP, mapped).is_some());
        let font_name = standard.or(non_standard).map_or(normalized, str::to_owned);
        if let Some((_, [ascent, descent, cap_height])) = FONT_BASIC_METRICS.iter().find(|(basic_name, _)| *basic_name == font_name) {
            if self.ascent.is_nan() {
                self.ascent = ascent / PDF_GLYPH_SPACE_UNITS;
            }
            if self.descent.is_nan() {
                self.descent = descent / PDF_GLYPH_SPACE_UNITS;
            }
            if self.cap_height.is_nan() {
                self.cap_height = cap_height / PDF_GLYPH_SPACE_UNITS;
            }
        }
        let lower_font_name = font_name.to_lowercase();
        let lower_name = self.name.to_lowercase();
        let identity_encoding = self.cid_encoding.starts_with("Identity-");
        let mut amend = true;
        if (is_standard_font || is_mapped_to_standard) && self.ty == "CIDFontType2" && identity_encoding {
            let mut map = ToUnicodeMap::new();
            if lower_name.contains("trebuchet") {
                apply_standard_font_glyph_map(&mut map, &GLYPH_MAP_FOR_MAC_ORDERED_FONTS);
                apply_standard_font_glyph_map(&mut map, &SUPPLEMENTAL_GLYPH_MAP_FOR_TREBUCHET_MS);
            } else {
                apply_standard_font_glyph_map(&mut map, &GLYPH_MAP_FOR_STANDARD_FONTS);
                if lower_name.contains("arialblack") || lower_name.contains("arial-black") {
                    apply_standard_font_glyph_map(&mut map, &SUPPLEMENTAL_GLYPH_MAP_FOR_ARIAL_BLACK);
                } else if lower_name.contains("calibri") {
                    apply_standard_font_glyph_map(&mut map, &SUPPLEMENTAL_GLYPH_MAP_FOR_CALIBRI);
                }
            }
            if let Some(cid_to_gid_map) = &properties.cid_to_gid_map {
                for (char_code, cid) in code_values(&map) {
                    if let Some(glyph_id) = u32::try_from(cid).ok().and_then(|cid| cid_to_gid_map.get(&cid)) {
                        map.set(char_code, UniValue::Code(i64::from(*glyph_id)));
                    }
                }
                if cid_to_gid_map.len() as i64 != self.to_unicode.size() && properties.has_included_to_unicode_map && self.to_unicode.is_identity() {
                    for (char_code, cid) in code_values(&map) {
                        let known = u32::try_from(cid).ok().is_some_and(|cid| cid_to_gid_map.contains_key(&cid));
                        if !known && self.to_unicode.has(char_code) {
                            map.delete(char_code);
                        }
                    }
                }
            }
            if !self.to_unicode.is_identity() {
                self.to_unicode.for_each(|char_code, unicode| {
                    map.set(char_code, UniValue::Code(unicode.map_or(0, i64::from)));
                })?;
            }
            self.to_font_char = map.clone();
            self.to_unicode = ToUnicode::Map(map);
            // pdf.js amends the map the font had before this one replaced it.
            amend = false;
        } else if lower_font_name.contains("symbol") {
            let is_cid_keyed = self.composite && identity_encoding;
            let encoding: &[&str] = if is_cid_keyed { &SYMBOL_GLYPH_ID_ENCODING } else { &SYMBOL_SET_ENCODING };
            self.to_font_char = build_to_font_char(encoding, &GLYPHS_UNICODE, &self.differences);
        } else if lower_font_name.contains("dingbats") {
            self.to_font_char = build_to_font_char(&ZAPF_DINGBATS_ENCODING, &DINGBATS_GLYPHS_UNICODE, &self.differences);
        } else if is_standard_font || is_mapped_to_standard {
            let mut map = build_to_font_char(self.default_encoding, &GLYPHS_UNICODE, &self.differences);
            if self.ty == "CIDFontType2" && !identity_encoding && !self.to_unicode.is_identity() {
                self.to_unicode.for_each(|char_code, unicode| {
                    map.set(char_code, UniValue::Code(unicode.map_or(0, i64::from)));
                })?;
            }
            self.to_font_char = map;
        } else {
            let mut map = ToUnicodeMap::new();
            let composite = self.composite;
            let differences = &self.differences;
            let encoding = self.default_encoding;
            self.to_unicode.for_each(|char_code, unicode| {
                let mut unicode = unicode.map_or(0, i64::from);
                if !composite
                    && let Some(glyph_name) = glyph_name_of(differences, encoding, i64::from(char_code))
                    && let Some(glyph_unicode) = data::get_unicode_for_glyph(glyph_name, &GLYPHS_UNICODE)
                {
                    unicode = i64::from(glyph_unicode);
                }
                map.set(char_code, UniValue::Code(unicode));
            })?;
            if self.composite && self.to_unicode.is_identity() && (self.name.to_lowercase().contains("tahoma") || self.name.to_lowercase().contains("verdana"))
            {
                apply_standard_font_glyph_map(&mut map, &GLYPH_MAP_FOR_STANDARD_FONTS);
            }
            self.to_font_char = map;
        }
        if amend {
            self.amend_fallback_to_unicode(properties);
        }
        self.loaded_name = font_name.split('-').next().unwrap_or("").to_owned();
        Ok(())
    }

    /// `_spaceWidth`: the width of a space the font's own widths do not give, estimated from the width of a glyph
    /// that is about as wide (`space`, `minus`, `one`, `i`, `I`).
    pub fn space_width(&self) -> f64 {
        *self.space_width.get_or_init(|| {
            let mut width = None;
            for glyph_name in ["space", "minus", "one", "i", "I"] {
                let glyph_unicode = i64::from(data::glyph_unicode(glyph_name).unwrap_or(0));
                // `None` is a CID string that is neither one nor two bytes long (`undefined`, falsy like 0).
                let mut char_code: Option<i64> = Some(0);
                if self.composite
                    && let Some(cmap) = &self.cmap
                    && let Ok(code) = u32::try_from(glyph_unicode)
                    && cmap.contains(code)
                {
                    char_code = match cmap.lookup(code) {
                        Some(CMapValue::Cid(cid)) => Some(cid),
                        Some(CMapValue::Str(text)) => convert_cid_string(code, &text, false).unwrap_or(None),
                        _ => Some(0),
                    };
                }
                if char_code.is_none_or(|code| code == 0) {
                    char_code = Some(self.to_unicode.char_code_of(&UniValue::Code(glyph_unicode)));
                }
                if char_code.is_some_and(|code| code <= 0) {
                    char_code = Some(glyph_unicode);
                }
                let found = char_code.and_then(|code| self.widths.get(&code)).copied();
                if found.is_some_and(|found| found != 0.0 && !found.is_nan()) {
                    width = found;
                    break;
                }
            }
            match width {
                Some(width) if width != 0.0 && !width.is_nan() => width,
                _ => self.default_width,
            }
        })
    }

    /// The CID a character code stands for through the font's CMap (the code itself without one): what the widths and the
    /// glyphs of a CID font are looked up by. `None` where the CMap maps the code to something that is no CID.
    pub fn cid_of(&self, charcode: u32) -> Option<i64> {
        if let Some(cmap) = &self.cmap
            && cmap.contains(charcode)
        {
            return match cmap.lookup(charcode) {
                Some(CMapValue::Cid(cid)) => Some(cid),
                Some(CMapValue::Str(text)) => convert_cid_string(charcode, &text, false).unwrap_or(None),
                _ => None,
            };
        }
        Some(i64::from(charcode))
    }

    /// The glyph name of a code of a simple font: its `Differences` entry, else its base encoding's.
    pub fn glyph_name(&self, charcode: u32) -> Option<&str> {
        glyph_name_of(&self.differences, self.default_encoding, i64::from(charcode))
    }

    /// `glyph.fontChar` of a missing-file font as a code point: the character the substitute face is asked for.
    pub fn font_char_code(&self, charcode: u32) -> u32 {
        let mut font_char_code = match self.to_font_char.get(charcode) {
            Some(UniValue::Code(code)) if *code != 0 => *code,
            _ => i64::from(charcode),
        };
        let glyph_name = self.glyph_name(charcode);
        if matches!(glyph_name, Some(".notdef" | "")) && self.ty == "Type1" {
            font_char_code = 0x20;
        }
        data::map_special_unicode_values(u32::try_from(font_char_code).unwrap_or(u32::MAX))
    }

    /// `_charToGlyph(charcode, isSpace)`.
    fn char_to_glyph(&self, charcode: u32, is_space: bool) -> Arc<Glyph> {
        if let Some(glyph) = lock(&self.glyph_cache).get(&charcode)
            && glyph.is_space == is_space
        {
            return Arc::clone(glyph);
        }
        let mut width_code = Some(i64::from(charcode));
        if let Some(cmap) = &self.cmap
            && cmap.contains(charcode)
        {
            width_code = match cmap.lookup(charcode) {
                Some(CMapValue::Cid(cid)) => Some(cid),
                Some(CMapValue::Str(text)) => convert_cid_string(charcode, &text, false).unwrap_or(None),
                _ => None,
            };
        }
        let mut width = width_code.and_then(|code| self.widths.get(&code)).copied().unwrap_or(self.default_width);
        let mut vmetric = if self.vertical { width_code.and_then(|code| self.vmetrics.get(&code)).copied() } else { None };
        if vmetric.is_none()
            && let Some([w1y, _, vy]) = self.default_vmetrics
        {
            vmetric = Some([w1y, width * 0.5, vy]);
        }
        let mut unicode = match self.to_unicode.get(charcode) {
            Some(UniValue::Str(text)) if !text.is_empty() => text,
            Some(UniValue::Code(code)) if code != 0 => from_char_code(code),
            _ => from_char_code(i64::from(charcode)),
        };
        if self.missing_file {
            let mut font_char_code = match self.to_font_char.get(charcode) {
                Some(UniValue::Code(code)) if *code != 0 => *code,
                _ => i64::from(charcode),
            };
            let glyph_name = glyph_name_of(&self.differences, self.default_encoding, i64::from(charcode));
            if matches!(glyph_name, Some(".notdef" | "")) && self.ty == "Type1" {
                font_char_code = 0x20;
                if glyph_name == Some("") {
                    if width == 0.0 || width.is_nan() {
                        width = self.space_width();
                    }
                    if !self.to_unicode.has(charcode) {
                        unicode = from_char_code(font_char_code);
                    }
                }
            }
            let font_char_code = data::map_special_unicode_values(u32::try_from(font_char_code).unwrap_or(u32::MAX));
            if self.vertical
                && font_char_code < 0x1_0000
                && let Some(vertical) = data::lookup_code(&VERTICAL_PRESENTATION_FORM, font_char_code)
            {
                unicode = from_char_code(i64::from(vertical));
            }
        }
        let glyph = Arc::new(Glyph { original_char_code: charcode, unicode, width, vmetric, is_space });
        lock(&self.glyph_cache).insert(charcode, Arc::clone(&glyph));
        glyph
    }

    /// `charsToGlyphs(chars)`: the glyphs of a string of character codes (the bytes of a PDF string).
    pub fn chars_to_glyphs(&self, chars: &[u8]) -> Vec<Arc<Glyph>> {
        if let Some(glyphs) = lock(&self.chars_cache).get(chars) {
            return glyphs.clone();
        }
        let mut glyphs = Vec::new();
        if let Some(cmap) = &self.cmap {
            let mut i = 0;
            while i < chars.len() {
                let (charcode, length) = cmap.read_char_code(chars, i);
                i += length;
                let is_space = length == 1 && chars.get(i - 1) == Some(&0x20);
                glyphs.push(self.char_to_glyph(charcode, is_space));
            }
        } else {
            for &byte in chars {
                glyphs.push(self.char_to_glyph(u32::from(byte), byte == 0x20));
            }
        }
        lock(&self.chars_cache).insert(chars.to_vec(), glyphs.clone());
        glyphs
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The entries of a map of numbers as `(code, value)`.
fn code_values(map: &ToUnicodeMap) -> Vec<(u32, i64)> {
    map.iter()
        .map(|(code, value)| match value {
            UniValue::Code(value) => (code, *value),
            UniValue::Str(_) => (code, 0),
        })
        .collect()
}

/// The `fallbackName` capture of `/^InvalidPDFjsFont_(.*)_\d+$/`.
fn invalid_pdfjs_font_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("InvalidPDFjsFont_")?;
    let (captured, digits) = rest.rsplit_once('_')?;
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(captured)
}

/// The properties of a font the CFF reader reads and sets.
fn cff_properties_of(properties: &Properties) -> CffProperties {
    CffProperties {
        bbox: properties.bbox.map(|bbox| bbox.to_vec()),
        font_matrix: properties.font_matrix.map(|matrix| matrix.to_vec()),
        ..CffProperties::default()
    }
}

/// `new CFFFont(file, properties)`: the program's matrix and its built-in encoding.
fn read_cff_program(file: &[u8], properties: &mut Properties) -> Result<()> {
    let mut cff_properties = cff_properties_of(properties);
    read_cff_font(file, &mut cff_properties)?;
    if let Some(matrix) = &cff_properties.font_matrix {
        properties.font_matrix = Some(matrix_of(matrix));
    }
    properties.built_in_encoding = cff_properties.built_in_encoding;
    Ok(())
}

/// `new Type1Font(name, file, properties)`: the program's matrix, widths and encoding.
fn read_type1_program(file: &[u8], properties: &mut Properties) -> Result<()> {
    let mut type1_properties = Type1Properties {
        length1: properties.length1,
        composite: properties.composite,
        first_char: properties.first_char,
        last_char: properties.last_char,
        widths: properties.widths.clone(),
        font_matrix: properties.font_matrix.map(|matrix| matrix.to_vec()),
        ..Type1Properties::default()
    };
    Type1Font::parse(file, &mut type1_properties)?;
    if properties.is_internal_font && !properties.composite && type1_properties.built_in_encoding.is_none() {
        return Err(PdfError::Unknown("Cannot read properties of undefined (reading 'length')".to_owned()));
    }
    if let Some(matrix) = &type1_properties.font_matrix {
        properties.font_matrix = Some(matrix_of(matrix));
    }
    properties.widths = type1_properties.widths;
    properties.built_in_encoding = type1_properties.built_in_encoding;
    Ok(())
}

// ---- the font that failed, and the font with its name ---------------------------------------------------------------

/// `ErrorFont`: a font that could not be made. It has no glyphs.
#[derive(Debug, Clone)]
pub struct ErrorFont {
    pub error: String,
}

/// What a `TranslatedFont` holds.
#[derive(Debug)]
pub enum FontKind {
    Font(Box<Font>),
    Error(ErrorFont),
}

/// `TranslatedFont`: the font and the name pdf.js gave it (`g_d<doc>_f<n>`, the `fontName` of the text items).
#[derive(Debug)]
pub struct TranslatedFont {
    pub loaded_name: String,
    pub font: FontKind,
}

impl TranslatedFont {
    fn error(loaded_name: &str, message: String) -> Self {
        TranslatedFont { loaded_name: loaded_name.to_owned(), font: FontKind::Error(ErrorFont { error: message }) }
    }

    /// The font, `None` for an `ErrorFont`.
    pub fn font(&self) -> Option<&Font> {
        match &self.font {
            FontKind::Font(font) => Some(font),
            FontKind::Error(_) => None,
        }
    }

    /// `font.charsToGlyphs(chars)`: an `ErrorFont` has none.
    pub fn chars_to_glyphs(&self, chars: &[u8]) -> Vec<Arc<Glyph>> {
        self.font().map_or_else(Vec::new, |font| font.chars_to_glyphs(chars))
    }

    /// `font.isType3Font`.
    pub fn is_type3_font(&self) -> bool {
        self.font().is_some_and(|font| font.is_type3_font)
    }
}

// ---- Type 3 glyph descriptions -------------------------------------------------------------------------------------

/// What the first operator of a Type 3 glyph description says.
#[derive(Debug, Clone)]
pub enum CharProcFirstOp {
    /// Neither `d0` nor `d1`, or the description could not be evaluated.
    Other,
    /// `d1`: the operands (`wx wy llx lly urx ury`).
    WidthAndBounds([f64; 6]),
    /// `d0`: the bounding box of each path the description draws (the `minMax` of its `constructPath` operators).
    Width { path_bounds: Vec<[f64; 4]> },
}

/// Evaluates a glyph description of a Type 3 font far enough to give its first operator (the part of
/// `TranslatedFont.loadType3Data` that is about the font's bounding box). The text reader supplies it.
pub trait Type3CharProcs {
    /// `char_proc` is the description (a stream) as the font's `/CharProcs` has it, `resources` the font's resources
    /// (or the page's), `font_ref` the reference of the Type 3 font the glyph belongs to.
    fn first_operation(&self, char_proc: &Obj, resources: &Dict, font_ref: Option<Ref>) -> CharProcFirstOp;
}

/// A scanner that reads no description: a Type 3 font then keeps the bounding box its dictionary gives.
pub struct NoType3Scan;

impl Type3CharProcs for NoType3Scan {
    fn first_operation(&self, _: &Obj, _: &Dict, _: Option<Ref>) -> CharProcFirstOp {
        CharProcFirstOp::Other
    }
}

/// `Util.rectBoundingBox(x0, y0, x1, y1, minMax)`.
fn rect_bounding_box(rect: [f64; 4], min_max: &mut [f64; 4]) {
    min_max[0] = min_max[0].min(rect[0]).min(rect[2]);
    min_max[1] = min_max[1].min(rect[1]).min(rect[3]);
    min_max[2] = min_max[2].max(rect[0]).max(rect[2]);
    min_max[3] = min_max[3].max(rect[1]).max(rect[3]);
}

/// `Util.normalizeRect`.
fn normalize_rect(rect: [f64; 4]) -> [f64; 4] {
    let mut out = rect;
    if rect[0] > rect[2] {
        out[0] = rect[2];
        out[2] = rect[0];
    }
    if rect[1] > rect[3] {
        out[1] = rect[3];
        out[3] = rect[1];
    }
    out
}

/// `loadType3Data`: the font must have `/CharProcs`; the descriptions that give a bounding box of their own (a `d1`
/// box that is at least ten times the size of the font's, or the paths of a `d0` description when the font has none)
/// give the font one (`isCharBBox`).
fn load_type3_data(xref: &Xref, font: &mut Font, dict: &Dict, resources: &Dict, font_ref: Option<Ref>, scanner: &dyn Type3CharProcs) -> Result<()> {
    let char_procs = match xref.get(dict, "CharProcs")? {
        Obj::Dict(char_procs) => char_procs,
        _ => {
            return Err(PdfError::Unknown("Type3 font load error: charProcs.getKeys is not a function".to_owned()));
        }
    };
    let font_resources = match xref.get(dict, "Resources")? {
        Obj::Dict(font_resources) => Some(font_resources),
        _ => None,
    };
    let resources = font_resources.as_deref().unwrap_or(resources);
    let [x0, y0, x1, y1] = font.bbox.unwrap_or([0.0; 4]);
    let font_bbox_size = (x1 - x0).hypot(y1 - y0);
    let mut char_bbox: Option<[f64; 4]> = None;
    let init = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let keys: Vec<String> = char_procs.keys().map(str::to_owned).collect();
    for key in keys {
        let char_proc = match xref.get(&char_procs, &key) {
            Ok(char_proc) => char_proc,
            Err(error) if error.is_fatal() => return Err(error),
            Err(_) => {
                tracing::warn!("Type3 font resource \"{key}\" is not available.");
                continue;
            }
        };
        match scanner.first_operation(&char_proc, resources, font_ref) {
            CharProcFirstOp::WidthAndBounds(args) => {
                let bbox = normalize_rect([args[2], args[3], args[4], args[5]]);
                let width = bbox[2] - bbox[0];
                let height = bbox[3] - bbox[1];
                if width == 0.0 || height == 0.0 {
                    continue;
                }
                let size = width.hypot(height);
                if font_bbox_size == 0.0 || (size / font_bbox_size).round() >= 10.0 {
                    rect_bounding_box(bbox, char_bbox.get_or_insert(init));
                }
            }
            CharProcFirstOp::Width { path_bounds } => {
                if font_bbox_size == 0.0 {
                    for bounds in path_bounds {
                        rect_bounding_box(bounds, char_bbox.get_or_insert(init));
                    }
                }
            }
            CharProcFirstOp::Other => {}
        }
    }
    if let Some(bbox) = char_bbox {
        font.is_char_bbox = true;
        font.bbox = Some(bbox);
    }
    Ok(())
}

// ---- translateFont ---------------------------------------------------------------------------------------------------

/// Whether JavaScript would call the value true.
fn truthy(obj: &Obj) -> bool {
    match obj {
        Obj::Null => false,
        Obj::Bool(value) => *value,
        Obj::Num(value) => *value != 0.0 && !value.is_nan(),
        Obj::Str(bytes) => !bytes.is_empty(),
        _ => true,
    }
}

/// The name of a `/FontName` or `/BaseFont`: a name, or a string made one (`Name.get`).
fn name_of(obj: &Obj) -> Option<String> {
    match obj {
        Obj::Name(name) => Some(name.to_string()),
        Obj::Str(bytes) => Some(bytes.iter().map(|byte| char::from(*byte)).collect()),
        _ => None,
    }
}

/// `lookupMatrix(arr, fallback)`.
fn lookup_matrix(obj: &Obj) -> Option<[f64; 6]> {
    let Obj::Array(items) = obj else {
        return None;
    };
    let values: Vec<f64> = items.iter().filter_map(Obj::as_num).collect();
    <[f64; 6]>::try_from(values).ok()
}

/// `lookupNormalRect(arr, fallback)`.
fn lookup_normal_rect(obj: &Obj) -> Option<[f64; 4]> {
    let Obj::Array(items) = obj else {
        return None;
    };
    let values: Vec<f64> = items.iter().filter_map(Obj::as_num).collect();
    <[f64; 4]>::try_from(values).ok().map(normalize_rect)
}

fn number_or(obj: &Obj, fallback: f64) -> f64 {
    match obj {
        Obj::Num(value) => *value,
        _ => fallback,
    }
}

fn integer_or(obj: &Obj, fallback: i64) -> i64 {
    match obj {
        Obj::Num(value) if is_integer(*value) => *value as i64,
        _ => fallback,
    }
}

/// `isKnownFontName(name)`.
fn is_known_font_name(name: &str) -> bool {
    let font_name = normalize_font_name(name);
    data::lookup(&STD_FONT_MAP, &font_name).is_some()
        || data::lookup(&NON_STD_FONT_MAP, &font_name).is_some()
        || data::contains_name(&SERIF_FONTS, &font_name)
        || data::contains_name(&SYMBOLS_FONTS, &font_name)
}

/// What `preEvaluateFont` finds out about a font dictionary.
struct PreEvaluated {
    descriptor: Obj,
    dict: Arc<Dict>,
    base_dict: Arc<Dict>,
    composite: bool,
    ty: String,
    first_char: i64,
    last_char: i64,
    to_unicode: Obj,
    hash: String,
}

fn fetch_item(xref: &Xref, item: Option<&Obj>) -> Result<Obj> {
    match item {
        Some(item) => xref.fetch_if_ref(item, false),
        None => Ok(Obj::Null),
    }
}

/// `preEvaluateFont(dict)`: the type, the descendant of a Type0 font, the characters the font covers, the descriptor
/// and a hash of what tells two fonts of one descriptor apart.
fn pre_evaluate_font(xref: &Xref, dict: &Arc<Dict>) -> Result<PreEvaluated> {
    let base_dict = Arc::clone(dict);
    let mut dict = Arc::clone(dict);
    let Obj::Name(subtype) = xref.get(&dict, "Subtype")? else {
        return Err(PdfError::format("invalid font Subtype"));
    };
    let mut ty = subtype.to_string();
    let mut composite = false;
    if ty == "Type0" {
        let descendants = xref.get(&dict, "DescendantFonts")?;
        if !truthy(&descendants) {
            return Err(PdfError::format("Descendant fonts are not specified"));
        }
        let descendant = match &descendants {
            Obj::Array(items) => fetch_item(xref, items.first())?,
            other => other.clone(),
        };
        let Obj::Dict(descendant) = descendant else {
            return Err(PdfError::format("Descendant font is not a dictionary."));
        };
        dict = descendant;
        let Obj::Name(subtype) = xref.get(&dict, "Subtype")? else {
            return Err(PdfError::format("invalid font Subtype"));
        };
        ty = subtype.to_string();
        composite = true;
    }
    let first_char = integer_or(&xref.get(&dict, "FirstChar")?, 0);
    let last_char = integer_or(&xref.get(&dict, "LastChar")?, if composite { 0xffff } else { 0xff });
    let descriptor = xref.get(&dict, "FontDescriptor")?;
    let to_unicode = {
        let own = xref.get(&dict, "ToUnicode")?;
        if truthy(&own) { own } else { xref.get(&base_dict, "ToUnicode")? }
    };
    let mut hash = String::new();
    if truthy(&descriptor) {
        let mut murmur = MurmurHash::new();
        match base_dict.get_raw("Encoding") {
            Some(Obj::Name(name)) => murmur.update_str(name),
            Some(Obj::Ref(reference)) => murmur.update_str(&reference.to_string()),
            Some(Obj::Dict(encoding)) => {
                for (_, entry) in encoding.iter() {
                    match entry {
                        Obj::Name(name) => murmur.update_str(name),
                        Obj::Ref(reference) => murmur.update_str(&reference.to_string()),
                        Obj::Array(entries) => {
                            let parts: Vec<String> = entries
                                .iter()
                                .map(|entry| match entry {
                                    Obj::Name(name) => name.to_string(),
                                    Obj::Num(number) => mixdog_js::number_to_string(*number),
                                    Obj::Ref(reference) => reference.to_string(),
                                    _ => String::new(),
                                })
                                .collect();
                            murmur.update_str(&parts.join(","));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        murmur.update_str(&format!("{first_char}-{last_char}"));
        match &to_unicode {
            Obj::Stream(stream) => murmur.update(stream.raw()),
            Obj::Name(name) => murmur.update_str(name),
            _ => {}
        }
        let widths = {
            let own = xref.get(&dict, "Widths")?;
            if truthy(&own) { own } else { xref.get(&base_dict, "Widths")? }
        };
        if let Obj::Array(entries) = widths {
            let parts: Vec<String> = entries.iter().filter_map(number_or_ref_string).collect();
            murmur.update_str(&parts.join(","));
        }
        if composite {
            murmur.update_str("compositeFont");
            let composite_widths = {
                let own = xref.get(&dict, "W")?;
                if truthy(&own) { own } else { xref.get(&base_dict, "W")? }
            };
            if let Obj::Array(entries) = composite_widths {
                let mut parts = Vec::new();
                for entry in entries.iter() {
                    if let Some(text) = number_or_ref_string(entry) {
                        parts.push(text);
                    } else if let Obj::Array(elements) = entry {
                        let sub: Vec<String> = elements.iter().filter_map(number_or_ref_string).collect();
                        parts.push(format!("[{}]", sub.join(",")));
                    }
                }
                murmur.update_str(&parts.join(","));
            }
            match dict.get_raw("CIDToGIDMap").or_else(|| base_dict.get_raw("CIDToGIDMap")) {
                Some(Obj::Name(name)) => murmur.update_str(name),
                Some(Obj::Ref(reference)) => murmur.update_str(&reference.to_string()),
                _ => {}
            }
        }
        if ty == "Type3"
            && let Obj::Dict(char_procs) = xref.get(&base_dict, "CharProcs")?
        {
            for (key, entry) in char_procs.iter() {
                match entry {
                    Obj::Ref(reference) => murmur.update_str(&format!("{key}\0{reference}")),
                    _ => murmur.update_str(key),
                }
            }
        }
        hash = murmur.hexdigest();
    }
    Ok(PreEvaluated { descriptor, dict, base_dict, composite, ty, first_char, last_char, to_unicode, hash })
}

/// `entry.toString()` of a number or a reference, `None` for anything else.
fn number_or_ref_string(entry: &Obj) -> Option<String> {
    match entry {
        Obj::Num(number) => Some(mixdog_js::number_to_string(*number)),
        Obj::Ref(reference) => Some(reference.to_string()),
        _ => None,
    }
}

/// The font descriptor path of `translateFont`: a font file, if any, the descriptor's numbers and flags, the CMap of a
/// CID font, the data structures and the widths.
fn translate_with_descriptor(xref: &Xref, pre: &PreEvaluated, descriptor: &Dict, loaded_name: &str) -> Result<Font> {
    let dict = &pre.dict;
    let is_type3_font = pre.ty == "Type3";
    let mut font_name = name_of(&xref.get(descriptor, "FontName")?);
    let base_font = name_of(&xref.get(dict, "BaseFont")?);
    if is_type3_font {
        if font_name.is_none() {
            font_name = Some(pre.ty.clone());
        }
    } else if font_name != base_font {
        tracing::info!(
            "The FontDescriptor's FontName is \"{}\" but should be the same as the Font's BaseFont \"{}\".",
            font_name.as_deref().unwrap_or("undefined"),
            base_font.as_deref().unwrap_or("undefined")
        );
        if let (Some(from_descriptor), Some(from_font)) = (&font_name, &base_font)
            && (from_font.starts_with(from_descriptor.as_str()) || (!is_known_font_name(from_descriptor) && is_known_font_name(from_font)))
        {
            font_name = None;
        }
        font_name = font_name.or(base_font);
    }
    let Some(font_name) = font_name else {
        return Err(PdfError::format("invalid font name"));
    };
    let mut font_file: Option<Vec<u8>> = None;
    let mut font_file_n = None;
    let mut font_file_dict: Option<Arc<Dict>> = None;
    let located = || -> Result<Option<(&'static str, Arc<PdfStream>)>> {
        for n in ["FontFile", "FontFile2", "FontFile3"] {
            let file = xref.get(descriptor, n)?;
            if truthy(&file) {
                return match file {
                    Obj::Stream(stream) => Ok(Some((n, stream))),
                    _ => Err(PdfError::format("FontFile should be a stream")),
                };
            }
        }
        Ok(None)
    };
    match located().and_then(|found| match found {
        Some((n, stream)) => {
            let bytes = stream.decode(xref.filters().as_ref(), xref.guard())?;
            if bytes.is_empty() {
                return Err(PdfError::format("FontFile is empty"));
            }
            Ok(Some((n, stream, bytes)))
        }
        None => Ok(None),
    }) {
        Ok(Some((n, stream, bytes))) => {
            font_file_n = Some(n);
            font_file_dict = Some(Arc::clone(&stream.dict));
            font_file = Some(bytes);
        }
        Ok(None) => {}
        Err(error) if error.is_fatal() => return Err(error),
        Err(error) => {
            tracing::warn!("translateFont - fetching \"{font_name}\" font file: \"{error}\".");
        }
    }
    let mut is_internal_font = false;
    let mut subtype = None;
    let mut length1 = None;
    if let Some(file_dict) = &font_file_dict {
        if let Obj::Name(name) = xref.get(file_dict, "Subtype")? {
            subtype = Some(name.to_string());
        }
        length1 = xref.get(file_dict, "Length1")?.as_num();
    } else if !is_type3_font && let Some(standard_name) = get_standard_font_name(&font_name) {
        let standard = standard_font_data(standard_name);
        is_internal_font = standard.is_some();
        font_file = standard.map(<[u8]>::to_vec);
    }
    let font_matrix = lookup_matrix(&xref.get_array(dict, "FontMatrix")?).unwrap_or(FONT_IDENTITY_MATRIX);
    let descriptor_bbox = xref.get_array(descriptor, "FontBBox")?;
    let bbox_source = if truthy(&descriptor_bbox) { descriptor_bbox } else { xref.get_array(dict, "FontBBox")? };
    let bbox = lookup_normal_rect(&bbox_source).or(is_type3_font.then_some([0.0; 4]));
    let flags = match xref.get(descriptor, "Flags")? {
        Obj::Num(flags) if is_integer(flags) => js_to_int32(flags),
        _ => 0,
    };
    let mut properties = Properties {
        ty: pre.ty.clone(),
        subtype,
        name: font_name.clone(),
        loaded_name: loaded_name.to_owned(),
        has_file: font_file.is_some(),
        font_file_n,
        length1,
        is_internal_font,
        composite: pre.composite,
        font_matrix: Some(font_matrix),
        first_char: pre.first_char,
        last_char: pre.last_char,
        to_unicode_obj: pre.to_unicode.clone(),
        bbox,
        ascent: number_or(&xref.get(descriptor, "Ascent")?, f64::NAN),
        descent: number_or(&xref.get(descriptor, "Descent")?, f64::NAN),
        x_height: number_or(&xref.get(descriptor, "XHeight")?, 0.0),
        cap_height: number_or(&xref.get(descriptor, "CapHeight")?, 0.0),
        flags,
        italic_angle: number_or(&xref.get(descriptor, "ItalicAngle")?, 0.0),
        is_type3: is_type3_font,
        ..Properties::default()
    };
    if pre.composite {
        let cid_encoding = xref.get(&pre.base_dict, "Encoding")?;
        if let Obj::Name(name) = &cid_encoding {
            properties.cid_encoding = Some(name.to_string());
        }
        let cmap = match &cid_encoding {
            Obj::Name(name) => CMapFactory::create(Some(CMapEncoding::Name(name)), None, xref.guard())?,
            Obj::Stream(stream) => {
                let bytes = stream.decode(xref.filters().as_ref(), xref.guard())?;
                CMapFactory::create(Some(CMapEncoding::Stream(&bytes)), None, xref.guard())?
            }
            _ => CMapFactory::create(None, None, xref.guard())?,
        };
        properties.vertical = cmap.vertical;
        properties.cmap = Some(cmap);
    }
    extract_data_structures(xref, dict, &mut properties)?;
    extract_widths(xref, dict, descriptor, &mut properties)?;
    Font::new(&font_name, font_file.as_deref(), properties)
}

/// The path of `translateFont` for a simple font without a descriptor: a Standard 14 font (or what its name says it
/// is), measured by the Standard 14 metrics.
fn translate_without_descriptor(xref: &Xref, pre: &PreEvaluated, loaded_name: &str) -> Result<Font> {
    let dict = &pre.dict;
    let Obj::Name(base_font) = xref.get(dict, "BaseFont")? else {
        return Err(PdfError::format("Base font is not specified"));
    };
    let base_font_name = normalize_font_name(&base_font);
    let metrics = get_base_font_metrics(&base_font_name);
    let without_style = base_font_name.split('-').next().unwrap_or("");
    let flags = (if is_serif_font(without_style) { font_flags::SERIF } else { 0 })
        | (if metrics.monospace { font_flags::FIXED_PITCH } else { 0 })
        | (if data::contains_name(&SYMBOLS_FONTS, without_style) { font_flags::SYMBOLIC } else { font_flags::NONSYMBOLIC });
    let mut properties = Properties {
        ty: pre.ty.clone(),
        name: base_font_name.clone(),
        loaded_name: loaded_name.to_owned(),
        default_width: metrics.default_width,
        is_simulated_flags: true,
        flags: flags as i32,
        first_char: pre.first_char,
        last_char: pre.last_char,
        to_unicode_obj: pre.to_unicode.clone(),
        ..Properties::default()
    };
    let widths = xref.get(dict, "Widths")?;
    let mut file = None;
    if let Some(standard_name) = get_standard_font_name(&base_font_name) {
        file = standard_font_data(standard_name);
        properties.is_internal_font = file.is_some();
    }
    extract_data_structures(xref, dict, &mut properties)?;
    properties.widths = if let Obj::Array(entries) = widths {
        let mut glyph_widths = BTreeMap::new();
        for (code, entry) in (pre.first_char..).zip(entries.iter()) {
            if let Obj::Num(width) = xref.fetch_if_ref(entry, false)? {
                glyph_widths.insert(code, width);
            }
        }
        glyph_widths
    } else {
        build_char_code_to_width(metrics.widths, &properties)
    };
    Font::new(&base_font_name, file, properties)
}

/// `translateFont(preEvaluatedFont)`.
fn translate_font(xref: &Xref, pre: &PreEvaluated, loaded_name: &str) -> Result<Font> {
    let is_type3_font = pre.ty == "Type3";
    match &pre.descriptor {
        Obj::Dict(descriptor) => translate_with_descriptor(xref, pre, descriptor, loaded_name),
        other if truthy(other) => Err(PdfError::Unknown("descriptor.get is not a function".to_owned())),
        _ if is_type3_font || pre.composite => translate_with_descriptor(xref, pre, &Dict::new(), loaded_name),
        _ => translate_without_descriptor(xref, pre, loaded_name),
    }
}

// ---- loadFont ----------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum CacheKey {
    Ref(Ref),
    /// A font dictionary that is not an indirect object (pdf.js's `cacheKey_<fontID>`): the dictionary itself.
    Dict(usize),
}

#[derive(Debug, Clone)]
struct Alias {
    font_id: String,
    alias_ref: Option<Ref>,
}

#[derive(Default)]
struct LoaderState {
    cache: HashMap<CacheKey, Arc<TranslatedFont>>,
    /// `descriptor.fontAliases`: by the descriptor dictionary (the object it was fetched as, or its address for a
    /// direct dictionary), then by hash.
    aliases: HashMap<String, HashMap<String, Alias>>,
    /// The dictionaries whose addresses are keys above, kept so that an address stays theirs.
    keep_alive: Vec<Arc<Dict>>,
    /// `PartialEvaluator.fallbackFontDict`: made once, so that its font is.
    fallback_dict: Option<Arc<Dict>>,
    /// `systemFontCache`: the names a substitute system font was made for (each took one font id).
    system_fonts: std::collections::HashSet<String>,
}

/// What `loadFont` is told besides the font: where it is called from.
pub struct LoadContext<'a> {
    /// `type3FontRefs`: the Type 3 fonts whose glyph descriptions are being evaluated; one of them used inside its own
    /// description is an error font.
    pub type3_font_refs: &'a HashSet<Ref>,
    /// `parsingType3Font`.
    pub parsing_type3_font: bool,
    pub type3: &'a dyn Type3CharProcs,
}

/// The fonts of one document (`fontCache`, the font ids of `idFactory` and the aliases of descriptors) and `loadFont`.
pub struct FontLoader {
    doc_id: String,
    ignore_errors: bool,
    use_system_fonts: bool,
    next_font_id: AtomicU32,
    state: Mutex<LoaderState>,
}

/// `PartialEvaluator.fallbackFontDict`: Helvetica in WinAnsi, for a font that cannot be found.
fn fallback_font_dict() -> Arc<Dict> {
    let mut dict = Dict::new();
    dict.set("BaseFont", Obj::name("Helvetica"));
    dict.set("Type", Obj::name("FallbackType"));
    dict.set("Subtype", Obj::name("FallbackType"));
    dict.set("Encoding", Obj::name("WinAnsiEncoding"));
    Arc::new(dict)
}

impl FontLoader {
    /// `doc_id` is pdf.js's document id (`d0`): the loaded names are `g_<doc_id>_f<n>`.
    pub fn new(doc_id: &str, ignore_errors: bool) -> Self {
        FontLoader {
            doc_id: doc_id.to_owned(),
            ignore_errors,
            use_system_fonts: true,
            next_font_id: AtomicU32::new(0),
            state: Mutex::new(LoaderState::default()),
        }
    }

    /// Whether a font that has no program of its own is given a substitute system font (`useSystemFonts`, on unless
    /// the document is opened without it): the substitute takes a font id of its own, once per name.
    pub fn with_system_fonts(mut self, use_system_fonts: bool) -> Self {
        self.use_system_fonts = use_system_fonts;
        self
    }

    /// `getFontSubstitution`'s id: a font read without a program of its own (no descriptor, or a descriptor with no
    /// `FontFile`) takes the next font id for the substitute system font, once for each name.
    fn take_substitute_id(&self, xref: &Xref, pre: &PreEvaluated) {
        if !self.use_system_fonts || pre.ty == "Type3" || pre.composite {
            return;
        }
        let has_program = match &pre.descriptor {
            Obj::Dict(descriptor) => {
                ["FontFile", "FontFile2", "FontFile3"].iter().any(|key| xref.get(descriptor, key).map(|file| truthy(&file)).unwrap_or(false))
            }
            _ => false,
        };
        if has_program {
            return;
        }
        let Ok(Obj::Name(base_font)) = xref.get(&pre.dict, "BaseFont") else {
            return;
        };
        // `fetchStandardFontData` with system fonts on still loads Symbol and ZapfDingbats: such a font is internal, and
        // `getFontSubstitution` is not called for it.
        if get_standard_font_name(&base_font).and_then(standard_font_data).is_some() {
            return;
        }
        let mut name: &str = &base_font;
        if (pre.ty == "TrueType" || pre.ty == "Type1")
            && name.len() > 7
            && name.as_bytes()[6] == b'+'
            && name.as_bytes()[..6].iter().all(u8::is_ascii_uppercase)
        {
            name = &name[7..];
        }
        if name.starts_with("InvalidPDFjsFont_") {
            return;
        }
        let key = normalize_font_name(name);
        if lock(&self.state).system_fonts.insert(key) {
            self.create_font_id();
        }
    }

    fn create_font_id(&self) -> String {
        format!("f{}", self.next_font_id.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn cached(&self, key: CacheKey) -> Option<Arc<TranslatedFont>> {
        lock(&self.state).cache.get(&key).cloned()
    }

    /// `loadFont(fontName, font, resources, task, fallbackFontDict, cssFontInfo, seenRefs)`. `font` is the reference
    /// or dictionary the caller has (the `Tf` operand names the font in `resources`, an `ExtGState` font gives it).
    /// Where pdf.js throws (a `/Font` resource that is not a dictionary) this fails; where it answers with an
    /// `ErrorFont` the font is an [`ErrorFont`].
    pub fn load_font(
        &self,
        xref: &Xref,
        font_name: Option<&str>,
        font: Option<&Obj>,
        resources: &Dict,
        context: &LoadContext<'_>,
    ) -> Result<Arc<TranslatedFont>> {
        let error_font = || Arc::new(TranslatedFont::error(ERROR_FONT_NAME, format!("Font \"{}\" is not available.", font_name.unwrap_or("null"))));
        let font_ref_raw: Option<Obj> = match font {
            Some(font) if truthy(font) => matches!(font, Obj::Ref(_)).then(|| font.clone()),
            _ => match xref.get(resources, "Font")? {
                Obj::Dict(font_resources) => font_name.and_then(|name| font_resources.get_raw(name)).cloned(),
                other if truthy(&other) => {
                    return Err(PdfError::Unknown("fontRes.getRaw is not a function".to_owned()));
                }
                _ => None,
            },
        };
        let mut font_obj: Obj = font.cloned().unwrap_or(Obj::Null);
        let mut font_ref = None;
        if let Some(raw) = font_ref_raw.as_ref().filter(|raw| truthy(raw)) {
            if let Obj::Ref(reference) = raw {
                font_ref = Some(*reference);
                if context.type3_font_refs.contains(reference) {
                    return Ok(error_font());
                }
                if let Some(cached) = self.cached(CacheKey::Ref(*reference)) {
                    return Ok(cached);
                }
            }
            match xref.fetch_if_ref(raw, false) {
                Ok(fetched) => font_obj = fetched,
                Err(error) if error.is_fatal() => return Err(error),
                Err(error) => tracing::warn!("loadFont - lookup failed: \"{error}\"."),
            }
        }
        let font_dict = match font_obj {
            Obj::Dict(dict) => dict,
            _ => {
                if !self.ignore_errors && !context.parsing_type3_font {
                    tracing::warn!("Font \"{}\" is not available.", font_name.unwrap_or("null"));
                    return Ok(error_font());
                }
                tracing::warn!("Font \"{}\" is not available -- attempting to fallback to a default font.", font_name.unwrap_or("null"));
                self.keyed_fallback_dict()
            }
        };
        let dict_key = Arc::as_ptr(&font_dict) as usize;
        if let Some(cached) = self.cached(CacheKey::Dict(dict_key)) {
            return Ok(cached);
        }
        let pre = match pre_evaluate_font(xref, &font_dict) {
            Ok(pre) => pre,
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => {
                tracing::warn!("loadFont - preEvaluateFont failed: \"{error}\".");
                return Ok(error_font());
            }
        };
        let (font_id, alias_hit) = self.font_id_of(&pre, font_ref);
        if let Some(alias) = alias_hit {
            return Ok(alias);
        }
        let loaded_name = format!("g_{}_{font_id}", self.doc_id);
        self.take_substitute_id(xref, &pre);
        let translated = match translate_font(xref, &pre, &loaded_name).and_then(|mut translated| {
            if translated.is_type3_font {
                load_type3_data(xref, &mut translated, &font_dict, resources, font_ref, context.type3)
                    .map_err(|error| if error.is_fatal() { error } else { PdfError::Unknown(format!("Type3 font load error: {}", error.message())) })?;
            }
            Ok(translated)
        }) {
            Ok(font) => TranslatedFont { loaded_name: loaded_name.clone(), font: FontKind::Font(Box::new(font)) },
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => {
                tracing::warn!("loadFont - translateFont failed: \"{error}\".");
                TranslatedFont { loaded_name: loaded_name.clone(), font: FontKind::Error(ErrorFont { error: error.message().to_owned() }) }
            }
        };
        let translated = Arc::new(translated);
        let mut state = lock(&self.state);
        match font_ref {
            Some(reference) => {
                state.cache.insert(CacheKey::Ref(reference), Arc::clone(&translated));
            }
            None => {
                state.keep_alive.push(Arc::clone(&font_dict));
                state.cache.insert(CacheKey::Dict(dict_key), Arc::clone(&translated));
            }
        }
        Ok(translated)
    }

    /// The fallback dictionary of this loader: the same dictionary each time, so that its font is made once.
    fn keyed_fallback_dict(&self) -> Arc<Dict> {
        let mut state = lock(&self.state);
        Arc::clone(state.fallback_dict.get_or_insert_with(fallback_font_dict))
    }

    /// The font id of the font (`fontAliases[hash].fontID`, or a new one) and, for a font whose descriptor and hash were
    /// seen under another reference, that reference's font.
    fn font_id_of(&self, pre: &PreEvaluated, font_ref: Option<Ref>) -> (String, Option<Arc<TranslatedFont>>) {
        let Obj::Dict(descriptor) = &pre.descriptor else {
            return (self.create_font_id(), None);
        };
        if pre.hash.is_empty() {
            return (self.create_font_id(), None);
        }
        let descriptor_key = descriptor.obj_id.clone().unwrap_or_else(|| format!("direct:{}", Arc::as_ptr(descriptor) as usize));
        let mut state = lock(&self.state);
        let existing = state.aliases.get(&descriptor_key).and_then(|aliases| aliases.get(&pre.hash)).cloned();
        let font_id = match existing {
            Some(alias) => {
                if let (Some(reference), Some(alias_ref)) = (font_ref, alias.alias_ref)
                    && let Some(cached) = state.cache.get(&CacheKey::Ref(alias_ref)).cloned()
                {
                    state.cache.insert(CacheKey::Ref(reference), Arc::clone(&cached));
                    return (alias.font_id, Some(cached));
                }
                alias.font_id
            }
            None => {
                state.keep_alive.push(Arc::clone(descriptor));
                self.create_font_id()
            }
        };
        let aliases = state.aliases.entry(descriptor_key).or_default();
        let alias = aliases.entry(pre.hash.clone()).or_insert_with(|| Alias { font_id: font_id.clone(), alias_ref: None });
        if font_ref.is_some() {
            alias.alias_ref = font_ref;
        }
        (font_id, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Document, OpenOptions};

    fn document_with(objects: &[&str]) -> Document {
        let mut pdf = String::from(
            "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
             2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
             3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n",
        );
        for (i, body) in objects.iter().enumerate() {
            pdf += &format!("{} 0 obj\n{body}\nendobj\n", i + 4);
        }
        pdf += "trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n";
        Document::open(pdf.into_bytes(), &OpenOptions::default()).expect("a document")
    }

    fn load_with(loader: &FontLoader, document: &Document, object: i64, scanner: &dyn Type3CharProcs) -> Arc<TranslatedFont> {
        let refs = HashSet::new();
        let context = LoadContext { type3_font_refs: &refs, parsing_type3_font: false, type3: scanner };
        loader.load_font(document.xref(), Some("F1"), Some(&Obj::Ref(Ref::new(object, 0))), &Dict::new(), &context).expect("a font")
    }

    fn load(loader: &FontLoader, document: &Document, object: i64) -> Arc<TranslatedFont> {
        load_with(loader, document, object, &NoType3Scan)
    }

    fn text(glyph: &Glyph) -> String {
        String::from_utf16_lossy(&glyph.unicode)
    }

    #[test]
    fn the_hash_is_pdfjs_murmur_hash() {
        let hash = |parts: &[&str]| {
            let mut murmur = MurmurHash::new();
            for part in parts {
                murmur.update_str(part);
            }
            murmur.hexdigest()
        };
        assert_eq!(hash(&[]), "8b41d6adf9eef6f4");
        assert_eq!(hash(&["WinAnsiEncoding"]), "a108102206814012");
        assert_eq!(hash(&["WinAnsiEncoding", "0-255"]), "067aef3eb8af58b1");
        assert_eq!(hash(&["abc"]), "46529153b02b0ca3");
        assert_eq!(hash(&["0-255", "500,600,700,278,250"]), "95d6687a457de229");
        assert_eq!(hash(&["compositeFont"]), "d136c6ba5809c39f");
        assert_eq!(hash(&[&"a".repeat(37), "b"]), "9632e0e4dd63ce2c");
        assert_eq!(hash(&["\u{100}\u{ff}\0x"]), "8c125b71cd11f4fe");
        assert_eq!(hash(&["12R", "0-255", "Identity-H", "compositeFont", "[0,1,2],[500]"]), "93cea2b9726066fa");
        let mut bytes = MurmurHash::new();
        bytes.update(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert_eq!(bytes.hexdigest(), "b66452464d1edacc");
    }

    #[test]
    fn an_invalid_pdfjs_font_names_its_family() {
        assert_eq!(invalid_pdfjs_font_name("InvalidPDFjsFont_Arial_12"), Some("Arial"));
        assert_eq!(invalid_pdfjs_font_name("InvalidPDFjsFont_A_B_3"), Some("A_B"));
        assert_eq!(invalid_pdfjs_font_name("InvalidPDFjsFont_Arial_"), None);
        assert_eq!(invalid_pdfjs_font_name("Arial"), None);
    }

    #[test]
    fn the_type_of_a_font_file_is_read_from_its_first_bytes() {
        let mut properties = Properties { ty: "TrueType".to_owned(), ..Properties::default() };
        assert_eq!(get_font_file_type(&[0, 1, 0, 0, 9], &properties).0, "TrueType");
        assert_eq!(get_font_file_type(b"OTTO..", &properties).0, "OpenType");
        assert_eq!(get_font_file_type(b"%!PS-AdobeFont", &properties).0, "Type1");
        assert_eq!(get_font_file_type(&[0x80, 1, 2, 3], &properties).0, "Type1");
        assert_eq!(get_font_file_type(&[1, 0, 4, 2], &properties), ("Type1".to_owned(), Some("Type1C".to_owned())));
        properties.composite = true;
        assert_eq!(get_font_file_type(&[1, 0, 4, 2], &properties), ("CIDFontType0".to_owned(), Some("CIDFontType0C".to_owned())));
        assert_eq!(get_font_file_type(b"ttcf", &properties).0, "CIDFontType2");
        // Bytes that are none of them leave the font's own type.
        assert_eq!(get_font_file_type(b"junk", &properties).0, "TrueType");
    }

    #[test]
    fn a_standard_font_without_a_descriptor_is_measured_by_the_standard_metrics() {
        let document = document_with(&["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        assert_eq!(translated.loaded_name, "g_d0_f1");
        let font = translated.font().expect("a font");
        assert!(font.missing_file);
        assert_eq!(font.loaded_name, "Helvetica");
        assert_eq!(font.fallback_name, "sans-serif");
        assert!((font.ascent - 0.718).abs() < 1e-9);
        let glyphs = translated.chars_to_glyphs(b"A\x80 ");
        assert_eq!(glyphs.len(), 3);
        assert_eq!(text(&glyphs[0]), "A");
        assert_eq!(glyphs[0].width, 667.0);
        assert_eq!(text(&glyphs[1]), "\u{20ac}");
        assert_eq!(glyphs[1].width, 556.0);
        assert!(glyphs[2].is_space && glyphs[2].width == 278.0);
        // The same reference is the same font.
        assert!(Arc::ptr_eq(&translated, &load(&loader, &document, 4)));
    }

    #[test]
    fn a_courier_font_is_monospace_and_a_serif_one_is_serif() {
        let document =
            document_with(&["<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"]);
        let loader = FontLoader::new("d0", true);
        let courier = load(&loader, &document, 4);
        assert_eq!(courier.font().expect("a font").fallback_name, "monospace");
        assert_eq!(courier.chars_to_glyphs(b"i")[0].width, 600.0);
        let times = load(&loader, &document, 5);
        assert_eq!(times.font().expect("a font").fallback_name, "serif");
        // Courier-Bold's substitute system font took f2.
        assert_eq!(times.loaded_name, "g_d0_f3");
    }

    #[test]
    fn symbol_is_read_from_its_bundled_program_and_its_encoding() {
        let document = document_with(&["<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>"]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        let font = translated.font().expect("a font");
        assert!(!font.missing_file, "the bundled Type 1 program is read");
        let glyph = &translated.chars_to_glyphs(b"a")[0];
        assert_eq!(text(glyph), "\u{3b1}");
        assert_eq!(glyph.width, 631.0);
    }

    #[test]
    fn a_to_unicode_stream_wins_and_the_encoding_fills_the_codes_it_lacks() {
        let document = document_with(&[
            "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Foo /FirstChar 65 /LastChar 66 \
             /Widths [600 700] /Encoding /WinAnsiEncoding /ToUnicode 5 0 R /FontDescriptor 6 0 R >>",
            "<< /Length 200 >>\nstream\n/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n\
             1 begincodespacerange <00> <ff> endcodespacerange\n\
             1 beginbfchar <41> <0058> endbfchar\nendcmap\nendstream",
            "<< /Type /FontDescriptor /FontName /ABCDEF+Foo /Flags 32 /Ascent 900 /Descent -300 >>",
        ]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        let glyphs = translated.chars_to_glyphs(b"AB");
        assert_eq!(text(&glyphs[0]), "X");
        assert_eq!(glyphs[0].width, 600.0);
        assert_eq!(text(&glyphs[1]), "B");
        assert_eq!(glyphs[1].width, 700.0);
        let font = translated.font().expect("a font");
        assert!((font.ascent - 0.9).abs() < 1e-9 && (font.descent + 0.3).abs() < 1e-9);
    }

    #[test]
    fn fonts_of_one_descriptor_and_one_hash_are_one_font() {
        let font = "<< /Type /Font /Subtype /TrueType /BaseFont /Foo /FirstChar 0 /LastChar 255 \
                    /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>";
        let document = document_with(&[font, font, "<< /Type /FontDescriptor /FontName /Foo /Flags 32 >>"]);
        let loader = FontLoader::new("d3", true);
        let first = load(&loader, &document, 4);
        let second = load(&loader, &document, 5);
        assert_eq!(first.loaded_name, "g_d3_f1");
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn a_font_that_is_not_a_font_is_an_error_font() {
        let document = document_with(&["<< /Type /Font >>"]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        assert_eq!(translated.loaded_name, ERROR_FONT_NAME);
        assert!(translated.font().is_none());
        assert!(translated.chars_to_glyphs(b"abc").is_empty());
    }

    #[test]
    fn a_missing_font_resource_falls_back_to_helvetica() {
        let document = document_with(&[]);
        let loader = FontLoader::new("d0", true);
        let refs = HashSet::new();
        let context = LoadContext { type3_font_refs: &refs, parsing_type3_font: false, type3: &NoType3Scan };
        let translated = loader.load_font(document.xref(), Some("F9"), None, &Dict::new(), &context).expect("a font");
        assert_eq!(translated.loaded_name, "g_d0_f1");
        assert_eq!(text(&translated.chars_to_glyphs(b"\xe9")[0]), "\u{e9}");
        // A font that is not there when pdf.js may not fall back is an error font.
        let strict = FontLoader::new("d0", false);
        let error = strict.load_font(document.xref(), Some("F9"), None, &Dict::new(), &context).expect("an answer");
        assert_eq!(error.loaded_name, ERROR_FONT_NAME);
    }

    const IDENTITY_CID_FONT: &str = "<< /Type /Font /Subtype /Type0 /BaseFont /Foo \
        /Encoding /Identity-H /DescendantFonts [5 0 R] >>";

    #[test]
    fn a_cid_font_reads_its_widths_and_its_identity_text() {
        let document = document_with(&[
            IDENTITY_CID_FONT,
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Foo /FontDescriptor 6 0 R \
             /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> \
             /DW 500 /W [1 [300 400] 10 12 700] >>",
            "<< /Type /FontDescriptor /FontName /Foo /Flags 4 /Ascent 800 /Descent -200 >>",
        ]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        let font = translated.font().expect("a font");
        assert!(font.composite && !font.vertical);
        let glyphs = translated.chars_to_glyphs(&[0, 2, 0, 11, 0, 99]);
        assert_eq!(glyphs.iter().map(|glyph| glyph.width).collect::<Vec<_>>(), vec![400.0, 700.0, 500.0]);
        assert_eq!(glyphs[2].original_char_code, 99);
        assert_eq!(text(&glyphs[2]), "c");
    }

    #[test]
    fn a_vertical_cid_font_has_vertical_metrics() {
        let document = document_with(&[
            "<< /Type /Font /Subtype /Type0 /BaseFont /Foo /Encoding /Identity-V \
             /DescendantFonts [5 0 R] >>",
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Foo /FontDescriptor 6 0 R \
             /DW 1000 /DW2 [800 -900] /W2 [2 [-500 250 700]] >>",
            "<< /Type /FontDescriptor /FontName /Foo /Flags 4 >>",
        ]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        assert!(translated.font().expect("a font").vertical);
        let glyphs = translated.chars_to_glyphs(&[0, 1, 0, 2]);
        assert_eq!(glyphs[0].vmetric, Some([-900.0, 500.0, 800.0]));
        assert_eq!(glyphs[1].vmetric, Some([-500.0, 250.0, 700.0]));
    }

    struct Scan(CharProcFirstOp);

    impl Type3CharProcs for Scan {
        fn first_operation(&self, _: &Obj, _: &Dict, _: Option<Ref>) -> CharProcFirstOp {
            self.0.clone()
        }
    }

    const TYPE3_FONT: &str = "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 100 100] \
        /FontMatrix [0.01 0 0 0.01 0 0] /CharProcs << /a 5 0 R >> \
        /Encoding << /Type /Encoding /Differences [97 /a] >> \
        /FirstChar 97 /LastChar 97 /Widths [50] >>";

    #[test]
    fn a_type3_font_takes_its_glyph_boxes_when_they_are_much_bigger() {
        let document = document_with(&[TYPE3_FONT, "<< /Length 20 >>\nstream\n50 0 0 0 1000 1000 d1\nendstream"]);
        let loader = FontLoader::new("d0", true);
        let big = Scan(CharProcFirstOp::WidthAndBounds([50.0, 0.0, 0.0, 0.0, 1000.0, 1000.0]));
        let translated = load_with(&loader, &document, 4, &big);
        let font = translated.font().expect("a font");
        assert!(font.is_type3_font && font.is_char_bbox);
        assert_eq!(font.bbox, Some([0.0, 0.0, 1000.0, 1000.0]));
        assert_eq!(font.font_matrix, Some([0.01, 0.0, 0.0, 0.01, 0.0, 0.0]));
        let glyph = &translated.chars_to_glyphs(b"a")[0];
        assert_eq!((text(glyph), glyph.width), ("a".to_owned(), 50.0));
        // A box of the font's own size changes nothing.
        let loader = FontLoader::new("d0", true);
        let small = Scan(CharProcFirstOp::WidthAndBounds([50.0, 0.0, 0.0, 0.0, 90.0, 90.0]));
        let translated = load_with(&loader, &document, 4, &small);
        let font = translated.font().expect("a font");
        assert!(!font.is_char_bbox);
        assert_eq!(font.bbox, Some([0.0, 0.0, 100.0, 100.0]));
    }

    #[test]
    fn a_type3_font_without_char_procs_is_an_error_font() {
        let document = document_with(&["<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] >>"]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        let FontKind::Error(error) = &translated.font else {
            panic!("an error font");
        };
        assert!(error.error.starts_with("Type3 font load error"));
        assert_eq!(translated.loaded_name, "g_d0_f1");
    }

    #[test]
    fn a_type3_font_inside_its_own_glyphs_is_an_error_font() {
        let document = document_with(&[TYPE3_FONT, "<< /Length 1 >>\nstream\n\nendstream"]);
        let loader = FontLoader::new("d0", true);
        let mut refs = HashSet::new();
        refs.insert(Ref::new(4, 0));
        let context = LoadContext { type3_font_refs: &refs, parsing_type3_font: true, type3: &NoType3Scan };
        let translated = loader.load_font(document.xref(), Some("F1"), Some(&Obj::Ref(Ref::new(4, 0))), &Dict::new(), &context).expect("an answer");
        assert_eq!(translated.loaded_name, ERROR_FONT_NAME);
    }

    #[test]
    fn the_space_width_is_estimated_from_a_glyph_about_as_wide() {
        let document = document_with(&[
            "<< /Type /Font /Subtype /Type1 /BaseFont /Foo /FirstChar 105 /LastChar 105 \
             /Widths [222] /Encoding /WinAnsiEncoding /FontDescriptor 5 0 R >>",
            "<< /Type /FontDescriptor /FontName /Foo /Flags 32 /MissingWidth 0 >>",
        ]);
        let loader = FontLoader::new("d0", true);
        let translated = load(&loader, &document, 4);
        let font = translated.font().expect("a font");
        assert_eq!(font.space_width(), 222.0);
    }
}
