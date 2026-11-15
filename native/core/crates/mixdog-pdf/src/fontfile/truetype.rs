//! The TrueType reader of the text path, ported from pdf.js 6.4.299 (`Font.checkAndRepair` of `src/core/fonts.js`
//! and what it calls): the table directory with its tolerance of broken entries, TrueType collections, the `cmap`
//! table with pdf.js's choice of subtable (formats 0, 2, 4, 6 and 12; pdf.js has no reader for format 10 and warns
//! `cmap table has unsupported format`), the `post` glyph names (formats 1, 2 and 3), the `name` table, the checks of
//! `maxp`, `head`, `hhea` and `OS/2`, and which glyphs the `glyf` table leaves empty (pdf.js's `hasGlyph`).
//!
//! Only what the text extraction reads is here. The rebuilt font file, the hinting programs and the outlines are not:
//! pdf.js builds them for rendering. Two things of `checkAndRepair` stay with the caller: the `CFF ` table of an
//! OpenType font (the CFF reader) and the hinting-program check (`sanitizeTTPrograms`), whose verdict could only
//! change a font that pdf.js refuses because its repaired glyph data no longer fits (glyph entries of `loca` that
//! overlap).
//!
//! The reads follow pdf.js's `Stream` exactly: a read past the end gives -1, `getBytes(0)` and `getString(0)` give
//! the rest of the file and `skip(0)` skips one byte, because the repaired fonts of real files depend on them.

use std::collections::{BTreeMap, HashSet};
use std::ops::Range;

use crate::error::{PdfError, Result};

/// The most mappings one `cmap` subtable may produce (pdf.js builds them in memory without a limit; a real font has
/// at most 0x110000).
const MAX_CMAP_MAPPINGS: usize = 1 << 24;
/// The most fonts one TrueType collection may list.
const MAX_COLLECTION_FONTS: u32 = 1 << 16;
/// The most custom glyph names one `post` table may hold.
const MAX_POST_NAMES: usize = 1 << 20;

/// `VALID_TABLES`: the tables `readTables` keeps.
const VALID_TABLES: [&str; 14] = [
    "OS/2", "cmap", "head", "hhea", "hmtx", "maxp", "name", "post", "loca", "glyf", "fpgm", "prep",
    "cvt ", "CFF ",
];

/// `MacStandardGlyphOrdering`: the 258 glyph names of `post` formats 1 and 2.
pub const MAC_STANDARD_GLYPH_ORDERING: [&str; 258] = [
    ".notdef", ".null", "nonmarkingreturn", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent",
    "ampersand", "quotesingle", "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period",
    "slash", "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "colon",
    "semicolon", "less", "equal", "greater", "question", "at", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
    "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "bracketleft", "backslash",
    "bracketright", "asciicircum", "underscore", "grave", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k",
    "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "braceleft", "bar", "braceright",
    "asciitilde", "Adieresis", "Aring", "Ccedilla", "Eacute", "Ntilde", "Odieresis", "Udieresis", "aacute",
    "agrave", "acircumflex", "adieresis", "atilde", "aring", "ccedilla", "eacute", "egrave", "ecircumflex",
    "edieresis", "iacute", "igrave", "icircumflex", "idieresis", "ntilde", "oacute", "ograve", "ocircumflex",
    "odieresis", "otilde", "uacute", "ugrave", "ucircumflex", "udieresis", "dagger", "degree", "cent",
    "sterling", "section", "bullet", "paragraph", "germandbls", "registered", "copyright", "trademark", "acute",
    "dieresis", "notequal", "AE", "Oslash", "infinity", "plusminus", "lessequal", "greaterequal", "yen", "mu",
    "partialdiff", "summation", "product", "pi", "integral", "ordfeminine", "ordmasculine", "Omega", "ae",
    "oslash", "questiondown", "exclamdown", "logicalnot", "radical", "florin", "approxequal", "Delta",
    "guillemotleft", "guillemotright", "ellipsis", "nonbreakingspace", "Agrave", "Atilde", "Otilde", "OE", "oe",
    "endash", "emdash", "quotedblleft", "quotedblright", "quoteleft", "quoteright", "divide", "lozenge",
    "ydieresis", "Ydieresis", "fraction", "currency", "guilsinglleft", "guilsinglright", "fi", "fl",
    "daggerdbl", "periodcentered", "quotesinglbase", "quotedblbase", "perthousand", "Acircumflex",
    "Ecircumflex", "Aacute", "Edieresis", "Egrave", "Iacute", "Icircumflex", "Idieresis", "Igrave", "Oacute",
    "Ocircumflex", "apple", "Ograve", "Uacute", "Ucircumflex", "Ugrave", "dotlessi", "circumflex", "tilde",
    "macron", "breve", "dotaccent", "ring", "cedilla", "hungarumlaut", "ogonek", "caron", "Lslash", "lslash",
    "Scaron", "scaron", "Zcaron", "zcaron", "brokenbar", "Eth", "eth", "Yacute", "yacute", "Thorn", "thorn",
    "minus", "multiply", "onesuperior", "twosuperior", "threesuperior", "onehalf", "onequarter",
    "threequarters", "franc", "Gbreve", "gbreve", "Idotaccent", "Scedilla", "scedilla", "Cacute", "cacute",
    "Ccaron", "ccaron", "dcroat",
];

/// `GLYPH_HEADER_SIZE` of the composite glyph code.
const GLYPH_HEADER_SIZE: i64 = 10;
const ARG_1_AND_2_ARE_WORDS: i64 = 1 << 0;
const WE_HAVE_A_SCALE: i64 = 1 << 3;
const MORE_COMPONENTS: i64 = 1 << 5;
const WE_HAVE_AN_X_AND_Y_SCALE: i64 = 1 << 6;
const WE_HAVE_A_TWO_BY_TWO: i64 = 1 << 7;
const WE_HAVE_INSTRUCTIONS: i64 = 1 << 8;

/// A `Stream` over the font file with pdf.js's behaviour at its edges.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn at(bytes: &'a [u8], pos: u64) -> Self {
        Reader {
            bytes,
            pos: usize::try_from(pos).unwrap_or(usize::MAX),
        }
    }

    /// `getByte`: -1 at the end.
    fn byte(&mut self) -> i32 {
        match self.bytes.get(self.pos) {
            Some(b) => {
                self.pos += 1;
                i32::from(*b)
            }
            None => -1,
        }
    }

    /// `peekByte`.
    fn peek_byte(&self) -> i32 {
        self.bytes.get(self.pos).map_or(-1, |b| i32::from(*b))
    }

    /// `getUint16`: -1 when fewer than two bytes remain.
    fn u16(&mut self) -> i32 {
        let b0 = self.byte();
        let b1 = self.byte();
        if b0 == -1 || b1 == -1 {
            -1
        } else {
            (b0 << 8) + b1
        }
    }

    /// `getInt32`: the four bytes (each -1 past the end) combined as `(b0 << 24) + (b1 << 16) + (b2 << 8) + b3`.
    fn int32(&mut self) -> i64 {
        let b0 = self.byte();
        let b1 = self.byte();
        let b2 = self.byte();
        let b3 = self.byte();
        i64::from(b0.wrapping_shl(24)) + i64::from(b1 << 16) + i64::from(b2 << 8) + i64::from(b3)
    }

    /// `getInt32() >>> 0`.
    fn uint32(&mut self) -> u32 {
        self.int32() as u32
    }

    /// `getBytes(length)`: 0 means to the end; the position becomes `min(pos + length, end)`, which is before the
    /// old position when the read started past the end.
    fn take(&mut self, length: i64) -> &'a [u8] {
        let end = i64::try_from(self.bytes.len()).unwrap_or(i64::MAX);
        let pos = i64::try_from(self.pos).unwrap_or(i64::MAX);
        let end_pos = if length == 0 {
            end
        } else {
            pos.saturating_add(length).min(end)
        };
        self.pos = usize::try_from(end_pos.max(0)).unwrap_or(0);
        if end_pos > pos && pos >= 0 {
            &self.bytes[pos as usize..end_pos as usize]
        } else {
            &[]
        }
    }

    /// `getString(length)`: the bytes as Latin-1 chars.
    fn string(&mut self, length: i64) -> String {
        latin1(self.take(length))
    }

    /// `peekBytes(length)`.
    fn peek_bytes(&self, length: usize) -> &'a [u8] {
        let start = self.pos.min(self.bytes.len());
        let end = start.saturating_add(length).min(self.bytes.len());
        &self.bytes[start..end]
    }

    /// `skip(n)`: `pos += n || 1`.
    fn skip(&mut self, n: u64) {
        let n = if n == 0 { 1 } else { n };
        self.pos = self
            .pos
            .saturating_add(usize::try_from(n).unwrap_or(usize::MAX));
    }

    fn position(&self) -> i64 {
        i64::try_from(self.pos).unwrap_or(i64::MAX)
    }
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|b| char::from(*b)).collect()
}

/// `int16(b0, b1)`: `None` is JS `NaN` (a byte that does not exist).
fn int16(b0: Option<u8>, b1: Option<u8>) -> Option<i32> {
    Some((i32::from(b0?) << 8) + i32::from(b1?))
}

/// `signedInt16(b0, b1)`.
fn signed_int16(b0: Option<u8>, b1: Option<u8>) -> Option<i32> {
    let value = int16(b0, b1)?;
    Some(if value & (1 << 15) != 0 {
        value - 0x10000
    } else {
        value
    })
}

/// The chars JS `\s` matches.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// One entry of the table directory (`readTableEntry`).
#[derive(Debug, Clone)]
pub struct Table {
    pub tag: String,
    pub checksum: u32,
    /// The offset the directory gives, from the start of the file.
    pub offset: u32,
    /// The length the directory gives (the data may be shorter when the file ends first).
    pub length: u32,
    data: Range<usize>,
}

/// The file bytes `readTableEntry` and the `loca` repair read for a table: `skip(offset)` from the start (so one byte
/// for an offset of 0) and `getBytes(length)` (so the rest of the file for a length of 0).
fn table_bytes(file_len: usize, offset: u64, length: u64) -> Range<usize> {
    let pos = if offset == 0 { 1 } else { offset };
    let pos = usize::try_from(pos).unwrap_or(usize::MAX);
    let end_pos = if length == 0 {
        file_len
    } else {
        pos.saturating_add(usize::try_from(length).unwrap_or(usize::MAX))
            .min(file_len)
    };
    if end_pos > pos { pos..end_pos } else { 0..0 }
}

/// `readOpenTypeHeader`.
struct OpenTypeHeader {
    version: String,
    num_tables: i32,
}

fn read_open_type_header(reader: &mut Reader<'_>) -> OpenTypeHeader {
    let version = reader.string(4);
    let num_tables = reader.u16();
    // searchRange, entrySelector, rangeShift
    reader.u16();
    reader.u16();
    reader.u16();
    OpenTypeHeader {
        version,
        num_tables,
    }
}

/// `readTableEntry`.
fn read_table_entry(reader: &mut Reader<'_>) -> Table {
    let tag = reader.string(4);
    let checksum = reader.uint32();
    let offset = reader.uint32();
    let length = reader.uint32();
    let data = table_bytes(reader.bytes.len(), u64::from(offset), u64::from(length));
    Table {
        tag,
        checksum,
        offset,
        length,
        data,
    }
}

/// `readTables`: the valid tables with a length, a later entry of the same tag replacing an earlier one.
fn read_tables(reader: &mut Reader<'_>, num_tables: i32) -> Vec<Table> {
    let mut tables: Vec<Table> = Vec::new();
    for _ in 0..num_tables.max(0) {
        let table = read_table_entry(reader);
        if !VALID_TABLES.contains(&table.tag.as_str()) {
            continue;
        }
        if table.length == 0 {
            continue;
        }
        match tables.iter_mut().find(|t| t.tag == table.tag) {
            Some(existing) => *existing = table,
            None => tables.push(table),
        }
    }
    tables
}

/// One Mac or Windows record of the `name` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameRecord {
    pub platform: i32,
    pub encoding: i32,
    pub language: i32,
    pub name: i32,
    pub length: i32,
    pub offset: i32,
}

impl NameRecord {
    /// `isMacNameRecord`.
    pub fn is_mac(&self) -> bool {
        self.platform == 1 && self.encoding == 0 && self.language == 0
    }

    /// `isWinNameRecord`.
    pub fn is_win(&self) -> bool {
        self.platform == 3 && self.encoding == 1 && self.language == 0x409
    }
}

/// `readNameTable`: the names by name id (`names[0]` the 8-bit ones of encoding 0, `names[1]` the UTF-16 ones, the
/// text of a lone surrogate replaced) and the Mac and Windows records.
#[derive(Debug, Clone, Default)]
pub struct NameTable {
    pub names: [BTreeMap<u16, String>; 2],
    pub records: Vec<NameRecord>,
}

impl NameTable {
    /// `namePrototype[0][6]`: the PostScript name.
    pub fn ps_name(&self) -> Option<&str> {
        self.names[0].get(&6).map(String::as_str)
    }
}

fn read_name_table_at(file: &[u8], table: &Table) -> NameTable {
    let start = u64::from(table.offset);
    let mut reader = Reader::at(file, start);
    let start = i64::try_from(start).unwrap_or(i64::MAX);
    let length = i64::from(table.length);
    let end = start.saturating_add(length);
    let format = reader.u16();
    if format != 0 || length < 6 {
        return NameTable::default();
    }
    let num_records = reader.u16();
    let strings_start = reader.u16();
    let mut records: Vec<NameRecord> = Vec::new();
    let mut i = 0;
    while i < num_records && reader.position() + 12 <= end {
        let record = NameRecord {
            platform: reader.u16(),
            encoding: reader.u16(),
            language: reader.u16(),
            name: reader.u16(),
            length: reader.u16(),
            offset: reader.u16(),
        };
        if record.is_mac() || record.is_win() {
            records.push(record);
        }
        i += 1;
    }
    let mut names: [BTreeMap<u16, String>; 2] = [BTreeMap::new(), BTreeMap::new()];
    for record in &records {
        if record.length <= 0 {
            continue;
        }
        let pos = start + i64::from(strings_start) + i64::from(record.offset);
        if pos + i64::from(record.length) > end {
            continue;
        }
        reader.pos = usize::try_from(pos).unwrap_or(usize::MAX);
        // A negative id is a property, not an element, of the JS array.
        let Ok(name_index) = u16::try_from(record.name) else {
            continue;
        };
        if record.encoding != 0 {
            let mut units: Vec<u16> = Vec::new();
            let mut j = 0;
            while j < record.length {
                units.push(reader.u16() as u16);
                j += 2;
            }
            names[1].insert(name_index, String::from_utf16_lossy(&units));
        } else {
            names[0].insert(name_index, reader.string(i64::from(record.length)));
        }
    }
    NameTable { names, records }
}

/// `readTrueTypeCollectionData`: the header version and tables of the font of a collection that `font_name` names.
fn read_collection_data(
    reader: &mut Reader<'_>,
    file: &[u8],
    font_name: &str,
) -> Result<(String, Vec<Table>)> {
    // `readTrueTypeCollectionHeader`
    reader.string(4);
    let major_version = reader.u16();
    reader.u16();
    let num_fonts = reader.uint32();
    if num_fonts > MAX_COLLECTION_FONTS {
        return Err(PdfError::format(format!(
            "Invalid TrueType Collection: {num_fonts} fonts."
        )));
    }
    let offset_table: Vec<u32> = (0..num_fonts).map(|_| reader.uint32()).collect();
    match major_version {
        1 => {}
        2 => {
            // dsigTag, dsigLength, dsigOffset
            reader.uint32();
            reader.uint32();
            reader.uint32();
        }
        _ => {
            return Err(PdfError::format(format!(
                "Invalid TrueType Collection majorVersion: {major_version}."
            )));
        }
    }
    let font_name_parts: Vec<&str> = font_name.split('+').collect();
    let mut fallback: Option<(String, Vec<Table>, String)> = None;
    for offset in offset_table {
        reader.pos = usize::try_from(offset).unwrap_or(usize::MAX);
        let header = read_open_type_header(reader);
        let tables = read_tables(reader, header.num_tables);
        let Some(name_table) = tables.iter().find(|t| t.tag == "name") else {
            return Err(PdfError::format(
                "TrueType Collection font must contain a \"name\" table.",
            ));
        };
        let names = read_name_table_at(file, name_table);
        for entry in names.names.iter().flat_map(BTreeMap::values) {
            let name_entry: String = entry.chars().filter(|c| !is_js_space(*c)).collect();
            if name_entry.is_empty() {
                continue;
            }
            if name_entry == font_name {
                return Ok((header.version, tables));
            }
            if font_name_parts.len() < 2 {
                continue;
            }
            for part in &font_name_parts {
                if name_entry == *part {
                    fallback = Some(((*part).to_owned(), tables.clone(), header.version.clone()));
                }
            }
        }
    }
    if let Some((name, tables, version)) = fallback {
        tracing::warn!(
            "TrueType Collection does not contain \"{font_name}\" font, falling back to \"{name}\" font instead."
        );
        return Ok((version, tables));
    }
    Err(PdfError::format(format!(
        "TrueType Collection does not contain \"{font_name}\" font."
    )))
}

/// One glyph-to-code pair of a `cmap` subtable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CmapMapping {
    pub char_code: i64,
    pub glyph_id: i64,
}

/// What `readCmapTable` returns: the subtable's platform and encoding (-1 when there is none), its mappings by
/// ascending character code with the first of a repeated code kept, and whether it is the 256-entry format 0.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmapTable {
    pub platform_id: i32,
    pub encoding_id: i32,
    pub mappings: Vec<CmapMapping>,
    pub has_short_cmap: bool,
}

impl CmapTable {
    fn none() -> Self {
        CmapTable {
            platform_id: -1,
            encoding_id: -1,
            mappings: Vec::new(),
            has_short_cmap: false,
        }
    }
}

/// What `readPostScriptTable` finds: the glyph names by glyph id (an entry is `None` where pdf.js has `undefined`),
/// whether the table is usable, and whether its version is unknown (then pdf.js falls back to the font's default
/// encoding for the names, which the caller does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostTable {
    pub glyph_names: Option<Vec<Option<String>>>,
    pub valid: bool,
    pub unsupported_version: bool,
}

/// The values `checkAndRepair` collects in `metricsOverride`. A value the table is too short for is `None` (JS
/// `NaN`) and its ratio is `NaN`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetricsOverride {
    pub units_per_em: Option<i32>,
    pub y_max: Option<i32>,
    pub y_min: Option<i32>,
    pub ascent: Option<i32>,
    pub descent: Option<i32>,
    pub line_gap: Option<i32>,
}

impl MetricsOverride {
    fn ratio(value: Option<i32>, units_per_em: Option<i32>) -> f64 {
        match (value, units_per_em) {
            (Some(v), Some(u)) => f64::from(v) / f64::from(u),
            _ => f64::NAN,
        }
    }

    /// `this.ascent`: `ascent / unitsPerEm`.
    pub fn ascent_ratio(&self) -> f64 {
        Self::ratio(self.ascent, self.units_per_em)
    }

    /// `this.descent`.
    pub fn descent_ratio(&self) -> f64 {
        Self::ratio(self.descent, self.units_per_em)
    }

    /// `this.lineGap`.
    pub fn line_gap_ratio(&self) -> f64 {
        Self::ratio(self.line_gap, self.units_per_em)
    }
}

/// What `checkAndRepair` learns from `maxp`, `head`, `loca` and `glyf` before it reads the `cmap` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlyphInfo {
    /// `numGlyphs`: from `maxp` or, for OpenType with CFF outlines, the CFF's charstring count.
    pub num_glyphs: i32,
    /// `missingGlyphs`: for each glyph whether `glyf` gives it no outline. `None` for fonts without `glyf`.
    pub missing_glyphs: Option<Vec<bool>>,
    /// `isGlyphLocationsLong`.
    pub is_glyph_locations_long: bool,
}

impl GlyphInfo {
    /// pdf.js's `hasGlyph(glyphId)`: `!missingGlyphs?.[glyphId]`.
    pub fn has_glyph(&self, glyph_id: i64) -> bool {
        match (&self.missing_glyphs, usize::try_from(glyph_id)) {
            (Some(missing), Ok(index)) => !missing.get(index).copied().unwrap_or(false),
            _ => true,
        }
    }
}

/// A TrueType or OpenType font file read the way `checkAndRepair` reads it.
#[derive(Debug, Clone)]
pub struct TrueTypeFont {
    file: Vec<u8>,
    header_version: String,
    tables: Vec<Table>,
}

impl TrueTypeFont {
    /// Reads the table directory of `file`, or of the font of a TrueType collection that `font_name` (the font's
    /// name, with its subset prefix if it has one) selects.
    pub fn parse(file: &[u8], font_name: &str) -> Result<Self> {
        let file = file.to_vec();
        let mut reader = Reader::at(&file, 0);
        let (header_version, tables) = if reader.peek_bytes(4) == b"ttcf" {
            read_collection_data(&mut reader, &file, font_name)?
        } else {
            let header = read_open_type_header(&mut reader);
            let tables = read_tables(&mut reader, header.num_tables);
            (header.version, tables)
        };
        Ok(TrueTypeFont {
            file,
            header_version,
            tables,
        })
    }

    /// The font file's bytes.
    pub fn file(&self) -> &[u8] {
        &self.file
    }

    /// `header.version`: `\0\x01\0\0`, `true`, `OTTO`, or what the file has.
    pub fn header_version(&self) -> &str {
        &self.header_version
    }

    /// `!tables["CFF "]`: the outlines are `glyf`, not CFF.
    pub fn is_true_type(&self) -> bool {
        self.table("CFF ").is_none()
    }

    /// The table with this tag.
    pub fn table(&self, tag: &str) -> Option<&Table> {
        self.tables.iter().find(|t| t.tag == tag)
    }

    /// The data of the table with this tag.
    pub fn table_data(&self, tag: &str) -> Option<&[u8]> {
        self.table(tag).map(|t| &self.file[t.data.clone()])
    }

    /// The tables in the order pdf.js's `tables` object holds them.
    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    fn required(&self, tag: &str) -> Result<&Table> {
        self.table(tag)
            .ok_or_else(|| PdfError::format(format!("Required \"{tag}\" table is not found")))
    }

    fn data_byte(&self, tag: &str, index: usize) -> Option<u8> {
        self.table_data(tag)?.get(index).copied()
    }

    /// The part of `checkAndRepair` between the table directory and `readCmapTable`, for what it reads and what it
    /// rejects: the required tables, `maxp`'s version and glyph count, `head`'s `indexToLocFormat`, the length of
    /// `loca`, and the glyphs `glyf` leaves empty. `num_glyphs_from_cff` is `numGlyphsFromCFF` of an OpenType font
    /// with CFF outlines. The errors are pdf.js's, by their messages.
    pub fn glyph_info(&self, num_glyphs_from_cff: Option<i32>) -> Result<GlyphInfo> {
        let loca = if self.is_true_type() {
            let loca = self.required("loca")?;
            if self.table("glyf").is_none() {
                tracing::warn!("Required \"glyf\" table is not found -- trying to recover.");
            }
            Some(loca)
        } else {
            None
        };
        let maxp = self.required("maxp")?;
        let mut reader = Reader::at(&self.file, u64::from(maxp.offset));
        let version = reader.int32();
        let num_glyphs = num_glyphs_from_cff.unwrap_or_else(|| reader.u16());
        if version != 0x0001_0000 && version != 0x0000_5000 && maxp.length != 6 && maxp.length < 32 {
            return Err(PdfError::format("\"maxp\" table has a wrong version number"));
        }
        let head = self.required("head")?;
        let is_long = int16(self.data_byte("head", 50), self.data_byte("head", 51))
            .is_some_and(|value| value != 0);
        let mut loca_range = loca.map(|t| t.data.clone());
        let mut loca_length = loca.map_or(0, |t| i64::from(t.length));
        if let Some(loca) = loca {
            let items = i64::from(num_glyphs) + 1;
            let expected = if is_long { items * 4 } else { items * 2 };
            if i64::from(loca.length) != expected {
                tracing::warn!("Incorrect 'loca' table length -- attempting to fix it.");
                let mut sorted: Vec<&Table> = self.tables.iter().collect();
                sorted.sort_by_key(|t| t.offset);
                let next = sorted
                    .iter()
                    .position(|t| t.tag == "loca")
                    .and_then(|i| sorted.get(i + 1));
                if let Some(next) = next
                    && i64::from(loca.offset) + expected < i64::from(next.offset)
                {
                    loca_range = Some(table_bytes(
                        self.file.len(),
                        u64::from(loca.offset),
                        u64::try_from(expected).unwrap_or(0),
                    ));
                    loca_length = expected;
                }
            }
        }
        // `sanitizeMetrics` reads `metrics.length` of the `hmtx` table whenever there is an `hhea`.
        if self.table("hhea").is_some() && self.table("hmtx").is_none() {
            return Err(PdfError::Unknown(
                "Cannot read properties of null (reading 'length')".to_owned(),
            ));
        }
        self.sanitize_head(head, num_glyphs, loca_length)?;
        let missing_glyphs = match loca_range {
            Some(range) => {
                let glyf = self
                    .table("glyf")
                    .map_or_else(Vec::new, |t| self.file[t.data.clone()].to_vec());
                Some(sanitize_glyph_locations(
                    &self.file[range],
                    glyf,
                    num_glyphs,
                    is_long,
                )?)
            }
            None => None,
        };
        self.required("hhea")?;
        Ok(GlyphInfo {
            num_glyphs,
            missing_glyphs,
            is_glyph_locations_long: is_long,
        })
    }

    /// `sanitizeHead`: what it throws.
    fn sanitize_head(&self, head: &Table, num_glyphs: i32, loca_length: i64) -> Result<()> {
        let data = &self.file[head.data.clone()];
        if data.len() < 4 {
            return Err(range_error());
        }
        let index_to_loc_format = signed_int16(data.get(50).copied(), data.get(51).copied());
        if let Some(format) = index_to_loc_format
            && !(0..=1).contains(&format)
        {
            tracing::info!("Attempting to fix invalid indexToLocFormat in head table: {format}");
            let plus_one = num_glyphs.wrapping_add(1);
            if loca_length != i64::from(plus_one.wrapping_shl(1))
                && loca_length != i64::from(plus_one.wrapping_shl(2))
            {
                return Err(PdfError::format(format!(
                    "Could not fix indexToLocFormat: {format}"
                )));
            }
        }
        Ok(())
    }

    /// `metricsOverride` of `checkAndRepair`, read from `head` and `hhea` (both required).
    pub fn metrics_override(&self) -> Result<MetricsOverride> {
        self.required("head")?;
        self.required("hhea")?;
        let head = |i| self.data_byte("head", i);
        let hhea = |i| self.data_byte("hhea", i);
        Ok(MetricsOverride {
            units_per_em: int16(head(18), head(19)),
            y_max: signed_int16(head(42), head(43)),
            y_min: signed_int16(head(38), head(39)),
            ascent: signed_int16(hhea(4), hhea(5)),
            descent: signed_int16(hhea(6), hhea(7)),
            line_gap: signed_int16(hhea(8), hhea(9)),
        })
    }

    /// `validateOS2Table`: whether the font's `OS/2` table is usable as it is. A font without one is not.
    pub fn validate_os2_table(&self) -> bool {
        let Some(os2) = self.table("OS/2") else {
            return false;
        };
        let mut reader = Reader::at(&self.file, u64::from(os2.offset));
        let version = reader.u16();
        let min_length = match version {
            0 => 78,
            1 => 86,
            2..=4 => 96,
            5 => 100,
            _ => return false,
        };
        if os2.length < min_length {
            return false;
        }
        reader.skip(60);
        let selection = reader.u16();
        if version < 4 && selection & 0x0300 != 0 {
            return false;
        }
        let first_char = reader.u16();
        let last_char = reader.u16();
        if first_char > last_char {
            return false;
        }
        reader.skip(6);
        reader.u16() != 0
    }

    /// `readNameTable` of the font's `name` table (`None` without one).
    pub fn read_name_table(&self) -> Option<NameTable> {
        self.table("name")
            .map(|table| read_name_table_at(&self.file, table))
    }

    /// `readPostScriptTable(post, properties, maxpNumGlyphs)` (`None` without a `post` table).
    pub fn read_post_script_table(&self, max_num_glyphs: i32) -> Option<PostTable> {
        let post = self.table("post")?;
        let start = u64::from(post.offset);
        let end = i64::try_from(start)
            .unwrap_or(i64::MAX)
            .saturating_add(i64::from(post.length));
        let mut reader = Reader::at(&self.file, start);
        let version = reader.int32();
        reader.skip(28);
        let mut glyph_names: Option<Vec<Option<String>>> = None;
        let mut valid = true;
        let mut unsupported_version = false;
        match version {
            0x0001_0000 => {
                glyph_names = Some(
                    MAC_STANDARD_GLYPH_ORDERING
                        .iter()
                        .map(|name| Some((*name).to_owned()))
                        .collect(),
                );
            }
            0x0002_0000 => {
                let num_glyphs = reader.u16();
                if num_glyphs != max_num_glyphs {
                    valid = false;
                } else {
                    let mut indexes: Vec<i32> = Vec::new();
                    for _ in 0..num_glyphs.max(0) {
                        let index = reader.u16();
                        if index >= 32768 {
                            valid = false;
                            break;
                        }
                        indexes.push(index);
                    }
                    if valid {
                        let mut custom_names: Vec<String> = Vec::new();
                        while reader.position() < end && custom_names.len() < MAX_POST_NAMES {
                            let len = reader.byte();
                            custom_names.push(reader.string(i64::from(len)));
                        }
                        glyph_names = Some(
                            indexes
                                .iter()
                                .map(|&j| match usize::try_from(j) {
                                    Ok(j) if j < 258 => Some(MAC_STANDARD_GLYPH_ORDERING[j].to_owned()),
                                    Ok(j) => custom_names.get(j - 258).cloned(),
                                    Err(_) => None,
                                })
                                .collect(),
                        );
                    }
                }
            }
            0x0003_0000 => {}
            _ => {
                tracing::warn!("Unknown/unsupported post table version {version}");
                valid = false;
                unsupported_version = true;
            }
        }
        Some(PostTable {
            glyph_names,
            valid,
            unsupported_version,
        })
    }

    /// `readCmapTable(cmap, file, isSymbolicFont, hasEncoding)`: pdf.js's choice among the subtables, and the
    /// mappings of the one chosen. A missing table, no usable subtable or an unsupported format give the empty result
    /// (platform and encoding -1). Errors are the ones pdf.js throws on a damaged format 2 table.
    pub fn read_cmap_table(&self, is_symbolic_font: bool, has_encoding: bool) -> Result<CmapTable> {
        let Some(cmap) = self.table("cmap") else {
            tracing::warn!("No cmap table available.");
            return Ok(CmapTable::none());
        };
        let start = u64::from(cmap.offset);
        let mut file = Reader::at(&self.file, start);
        file.skip(2);
        let num_tables = file.u16();
        let mut potential: Option<(i32, i32, u32)> = None;
        let mut can_break = false;
        for i in 0..num_tables.max(0) {
            let platform_id = file.u16();
            let encoding_id = file.u16();
            let offset = file.uint32();
            if potential.is_some_and(|(p, e, _)| p == platform_id && e == encoding_id) {
                continue;
            }
            let mut use_table = false;
            if (platform_id == 0 && matches!(encoding_id, 0 | 1 | 3))
                || (platform_id == 1 && encoding_id == 0)
            {
                use_table = true;
            } else if platform_id == 3 && encoding_id == 1 && (has_encoding || potential.is_none()) {
                use_table = true;
                if !is_symbolic_font {
                    can_break = true;
                }
            } else if is_symbolic_font && platform_id == 3 && encoding_id == 0 {
                use_table = true;
                let mut correctly_sorted = true;
                if i < num_tables - 1 {
                    let next = file.peek_bytes(2);
                    let next_platform = int16(next.first().copied(), next.get(1).copied());
                    if next_platform.is_some_and(|p| p < platform_id) {
                        correctly_sorted = false;
                    }
                }
                if correctly_sorted {
                    can_break = true;
                }
            }
            if use_table {
                potential = Some((platform_id, encoding_id, offset));
            }
            if can_break {
                break;
            }
        }
        let Some((platform_id, encoding_id, offset)) = potential else {
            tracing::warn!("Could not find a preferred cmap table.");
            return Ok(CmapTable::none());
        };
        file.pos = usize::try_from(start.saturating_add(u64::from(offset))).unwrap_or(usize::MAX);
        if file.peek_byte() == -1 {
            tracing::warn!("Could not find a preferred cmap table.");
            return Ok(CmapTable::none());
        }
        let format = file.u16();
        let mut has_short_cmap = false;
        let mappings = match format {
            0 => {
                has_short_cmap = true;
                read_cmap_format0(&mut file)
            }
            2 => read_cmap_format2(&mut file)?,
            4 => read_cmap_format4(&mut file)?,
            6 => read_cmap_format6(&mut file),
            12 => read_cmap_format12(&mut file)?,
            _ => {
                tracing::warn!("cmap table has unsupported format: {format}");
                return Ok(CmapTable::none());
            }
        };
        let mut seen = HashSet::new();
        let mut final_mappings: Vec<CmapMapping> = mappings
            .into_iter()
            .filter(|mapping| seen.insert(mapping.char_code))
            .collect();
        final_mappings.sort_by_key(|mapping| mapping.char_code);
        Ok(CmapTable {
            platform_id,
            encoding_id,
            mappings: final_mappings,
            has_short_cmap,
        })
    }
}

fn too_many_mappings() -> PdfError {
    PdfError::format("cmap table has too many mappings")
}

fn read_cmap_format0(file: &mut Reader<'_>) -> Vec<CmapMapping> {
    file.skip(2 + 2);
    let mut mappings = Vec::new();
    for char_code in 0..256_i64 {
        let index = file.byte();
        if index == 0 {
            continue;
        }
        mappings.push(CmapMapping {
            char_code,
            glyph_id: i64::from(index),
        });
    }
    mappings
}

fn read_cmap_format2(file: &mut Reader<'_>) -> Result<Vec<CmapMapping>> {
    struct SubHeader {
        first_code: i32,
        entry_count: i32,
        id_delta: i32,
        id_range_pos: usize,
    }
    file.skip(2 + 2);
    let mut sub_header_keys: Vec<i32> = Vec::with_capacity(256);
    let mut max_sub_header_key = 0;
    for _ in 0..256 {
        let key = file.u16() >> 3;
        sub_header_keys.push(key);
        max_sub_header_key = max_sub_header_key.max(key);
    }
    let mut sub_headers: Vec<SubHeader> = Vec::new();
    for _ in 0..=max_sub_header_key {
        let first_code = file.u16();
        let entry_count = file.u16();
        let b0 = file.byte();
        let b1 = file.byte();
        let id_delta = {
            let value = (b0 << 8) + b1;
            if value & (1 << 15) != 0 {
                value - 0x10000
            } else {
                value
            }
        };
        // `file.pos + file.getUint16()`: the position is read before the call.
        let pos = file.position();
        let range = file.u16();
        let id_range_pos = pos.saturating_add(i64::from(range)).max(0);
        sub_headers.push(SubHeader {
            first_code,
            entry_count,
            id_delta,
            id_range_pos: usize::try_from(id_range_pos).unwrap_or(usize::MAX),
        });
    }
    let undefined = || PdfError::Unknown("Cannot read properties of undefined".to_owned());
    let mut mappings = Vec::new();
    for (i, key) in sub_header_keys.iter().enumerate() {
        let i = i as i64;
        if *key == 0 {
            let first = sub_headers.first().ok_or_else(undefined)?;
            file.pos = first
                .id_range_pos
                .saturating_add(usize::try_from(2 * i).unwrap_or(0));
            let glyph_id = file.u16();
            mappings.push(CmapMapping {
                char_code: i,
                glyph_id: i64::from(glyph_id),
            });
        } else {
            let s = usize::try_from(*key)
                .ok()
                .and_then(|k| sub_headers.get(k))
                .ok_or_else(undefined)?;
            for j in 0..s.entry_count.max(0) {
                let char_code = (i << 8) + i64::from(j) + i64::from(s.first_code);
                file.pos = s
                    .id_range_pos
                    .saturating_add(usize::try_from(2 * i64::from(j)).unwrap_or(0));
                let mut glyph_id = file.u16();
                if glyph_id != 0 {
                    glyph_id = (glyph_id + s.id_delta) % 65536;
                }
                mappings.push(CmapMapping {
                    char_code,
                    glyph_id: i64::from(glyph_id),
                });
            }
        }
    }
    Ok(mappings)
}

fn read_cmap_format4(file: &mut Reader<'_>) -> Result<Vec<CmapMapping>> {
    struct Segment {
        end: i32,
        start: i32,
        delta: i32,
        offset_index: i64,
    }
    file.skip(2 + 2);
    let seg_count = file.u16() >> 1;
    file.skip(6);
    let count = usize::try_from(seg_count.max(0)).unwrap_or(0);
    let mut segments: Vec<Segment> = (0..count)
        .map(|_| Segment {
            end: file.u16(),
            start: 0,
            delta: 0,
            offset_index: -1,
        })
        .collect();
    file.skip(2);
    for segment in &mut segments {
        segment.start = file.u16();
    }
    for segment in &mut segments {
        segment.delta = file.u16();
    }
    let mut offsets_count: i64 = 0;
    for (seg_index, segment) in segments.iter_mut().enumerate() {
        let range_offset = file.u16();
        if range_offset == 0 {
            segment.offset_index = -1;
            continue;
        }
        let offset_index = i64::from(range_offset >> 1) - (i64::from(seg_count) - seg_index as i64);
        segment.offset_index = offset_index;
        offsets_count =
            offsets_count.max(offset_index + i64::from(segment.end) - i64::from(segment.start) + 1);
    }
    let offsets: Vec<i32> = (0..offsets_count.max(0)).map(|_| file.u16()).collect();
    let mut mappings = Vec::new();
    for segment in &segments {
        for j in segment.start..=segment.end {
            if j == 0xffff {
                continue;
            }
            let glyph_id = if segment.offset_index < 0 {
                Some(j)
            } else {
                usize::try_from(segment.offset_index + i64::from(j) - i64::from(segment.start))
                    .ok()
                    .and_then(|index| offsets.get(index).copied())
            };
            // `undefined + delta` is NaN, which `& 0xffff` makes 0.
            let glyph_id = glyph_id.map_or(0, |g| (g + segment.delta) & 0xffff);
            if mappings.len() >= MAX_CMAP_MAPPINGS {
                return Err(too_many_mappings());
            }
            mappings.push(CmapMapping {
                char_code: i64::from(j),
                glyph_id: i64::from(glyph_id),
            });
        }
    }
    Ok(mappings)
}

fn read_cmap_format6(file: &mut Reader<'_>) -> Vec<CmapMapping> {
    file.skip(2 + 2);
    let first_code = file.u16();
    let entry_count = file.u16();
    let mut mappings = Vec::new();
    for j in 0..entry_count.max(0) {
        let glyph_id = file.u16();
        mappings.push(CmapMapping {
            char_code: i64::from(first_code) + i64::from(j),
            glyph_id: i64::from(glyph_id),
        });
    }
    mappings
}

fn read_cmap_format12(file: &mut Reader<'_>) -> Result<Vec<CmapMapping>> {
    file.skip(2 + 4 + 4);
    let n_groups = file.uint32();
    let mut mappings: Vec<CmapMapping> = Vec::new();
    for _ in 0..n_groups {
        let start_char_code = i64::from(file.uint32());
        let end_char_code = i64::from(file.uint32());
        let glyph_code = i64::from(file.uint32());
        if end_char_code >= start_char_code {
            let span = usize::try_from(end_char_code - start_char_code + 1).unwrap_or(usize::MAX);
            if mappings.len().saturating_add(span) > MAX_CMAP_MAPPINGS {
                return Err(too_many_mappings());
            }
        }
        for (char_code, glyph_id) in (start_char_code..=end_char_code).zip(glyph_code..) {
            mappings.push(CmapMapping { char_code, glyph_id });
        }
    }
    Ok(mappings)
}

/// One component of a composite glyph.
struct Component {
    gid: usize,
    offset: i64,
    size: i64,
    flags: i64,
}

/// One `loca` entry as `sanitizeGlyphLocations` handles it.
struct LocaEntry {
    index: usize,
    offset: i64,
    end_offset: i64,
}

fn range_error() -> PdfError {
    PdfError::Unknown("Offset is outside the bounds of the DataView".to_owned())
}

/// `DataView.getUint16(at)`.
fn view_u16(glyf: &[u8], at: i64) -> Result<i64> {
    let at = usize::try_from(at).map_err(|_| range_error())?;
    match glyf.get(at..at.saturating_add(2)) {
        Some(bytes) => Ok(i64::from(u16::from_be_bytes([bytes[0], bytes[1]]))),
        None => Err(range_error()),
    }
}

/// `TypedArray.prototype.copyWithin(target, start, end)` with its clamping.
fn copy_within_clamped(data: &mut [u8], target: i64, start: i64, end: i64) {
    let len = i64::try_from(data.len()).unwrap_or(i64::MAX);
    let clamp = |v: i64| if v < 0 { (len + v).max(0) } else { v.min(len) };
    let to = clamp(target);
    let from = clamp(start);
    let end = clamp(end);
    let count = (end - from).min(len - to);
    if count > 0 {
        data.copy_within(from as usize..(from + count) as usize, to as usize);
    }
}

/// `pruneCompositeGlyphCycles`: removes the components that close a cycle of composite glyphs, in `glyf` itself, and
/// returns which glyphs are left without a component.
fn prune_composite_glyph_cycles(
    glyf: &mut [u8],
    entries: &[LocaEntry],
    num_glyphs: usize,
) -> Result<Vec<bool>> {
    let byte_length = i64::try_from(glyf.len()).unwrap_or(i64::MAX);
    let mut components: Vec<Option<Vec<Component>>> = (0..num_glyphs).map(|_| None).collect();
    for (i, slot) in components.iter_mut().enumerate() {
        let offset = entries[i].offset;
        let end_offset = entries[i].end_offset.min(byte_length);
        if end_offset - offset <= GLYPH_HEADER_SIZE {
            continue;
        }
        // `glyf.getInt16(offset) >= 0`
        if view_u16(glyf, offset)? < 0x8000 {
            continue;
        }
        let mut comps = Vec::new();
        let mut p = offset + GLYPH_HEADER_SIZE;
        while p + 4 <= end_offset {
            let flags = view_u16(glyf, p)?;
            let gid = view_u16(glyf, p + 2)?;
            let mut size = 4 + if flags & ARG_1_AND_2_ARE_WORDS != 0 { 4 } else { 2 };
            if flags & WE_HAVE_A_SCALE != 0 {
                size += 2;
            } else if flags & WE_HAVE_AN_X_AND_Y_SCALE != 0 {
                size += 4;
            } else if flags & WE_HAVE_A_TWO_BY_TWO != 0 {
                size += 8;
            }
            comps.push(Component {
                gid: usize::try_from(gid).unwrap_or(usize::MAX),
                offset: p,
                size,
                flags,
            });
            p += size;
            if flags & MORE_COMPONENTS == 0 {
                break;
            }
        }
        if !comps.is_empty() {
            *slot = Some(comps);
        }
    }
    const WHITE: u8 = 0;
    const GRAY: u8 = 1;
    const BLACK: u8 = 2;
    let mut state = vec![WHITE; num_glyphs];
    // `backEdges`: a Map in insertion order, node -> the component indexes to remove.
    let mut back_edges: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut start = 0;
    while start < num_glyphs {
        let this = start;
        start += 1;
        if state[this] != WHITE || components[this].is_none() {
            continue;
        }
        let mut stack: Vec<(usize, usize)> = vec![(this, 0)];
        state[this] = GRAY;
        while let Some(&(node, idx)) = stack.last() {
            let comps = components[node].as_deref().unwrap_or(&[]);
            if idx >= comps.len() {
                state[node] = BLACK;
                stack.pop();
                continue;
            }
            if let Some(top) = stack.last_mut() {
                top.1 += 1;
            }
            let next = comps[idx].gid;
            if next >= num_glyphs || state[next] == BLACK {
                continue;
            }
            if state[next] == WHITE {
                state[next] = GRAY;
                stack.push((next, 0));
                continue;
            }
            match back_edges.iter_mut().find(|(n, _)| *n == node) {
                Some((_, set)) => {
                    if !set.contains(&idx) {
                        set.push(idx);
                    }
                }
                None => back_edges.push((node, vec![idx])),
            }
        }
    }
    let mut dropped = vec![false; num_glyphs];
    for (g_idx, remove_set) in &back_edges {
        let comps = components[*g_idx].as_deref().unwrap_or(&[]);
        let remaining: Vec<&Component> = comps
            .iter()
            .enumerate()
            .filter(|(ci, _)| !remove_set.contains(ci))
            .map(|(_, c)| c)
            .collect();
        if remaining.is_empty() {
            dropped[*g_idx] = true;
            continue;
        }
        let end_offset = entries[*g_idx].end_offset.min(byte_length);
        let mut write_pos = entries[*g_idx].offset + GLYPH_HEADER_SIZE;
        for (ci, c) in remaining.iter().enumerate() {
            let is_last = ci + 1 == remaining.len();
            let mut new_flags = c.flags & !WE_HAVE_INSTRUCTIONS;
            new_flags = if is_last {
                new_flags & !MORE_COMPONENTS
            } else {
                new_flags | MORE_COMPONENTS
            };
            if write_pos != c.offset {
                copy_within_clamped(glyf, write_pos, c.offset, c.offset + c.size);
            }
            let at = usize::try_from(write_pos).map_err(|_| range_error())?;
            match glyf.get_mut(at..at.saturating_add(2)) {
                Some(bytes) => bytes.copy_from_slice(&(new_flags as u16).to_be_bytes()),
                None => return Err(range_error()),
            }
            write_pos += c.size;
        }
        if write_pos < end_offset {
            let from = usize::try_from(write_pos.max(0)).unwrap_or(0).min(glyf.len());
            let to = usize::try_from(end_offset.max(0)).unwrap_or(0).min(glyf.len());
            if from < to {
                glyf[from..to].fill(0);
            }
        }
    }
    Ok(dropped)
}

/// `glyf[k]` of a glyph's bytes: `None` is `undefined`.
fn glyph_byte(glyf: &[u8], k: i64) -> Option<u8> {
    usize::try_from(k).ok().and_then(|k| glyf.get(k).copied())
}

/// `glyf[k]` where `undefined` acts as 0 (every use inside a bitwise operation).
fn glyph_bits(glyf: &[u8], k: i64) -> i64 {
    i64::from(glyph_byte(glyf, k).unwrap_or(0))
}

fn glyph_signed16(glyf: &[u8], k: i64) -> i64 {
    signed_int16(glyph_byte(glyf, k), glyph_byte(glyf, k + 1)).map_or(0, i64::from)
}

/// `sanitizeGlyph`, for what it decides about the glyph: whether it keeps any bytes. It makes the same repairs in the
/// source data that pdf.js makes (the glyph's bounding box, the flag bits and the repeat byte), because glyphs whose
/// `loca` ranges overlap read what an earlier glyph repaired.
fn glyph_has_outline(source: &mut [u8], source_start: i64, source_end: i64) -> bool {
    let len = i64::try_from(source.len()).unwrap_or(i64::MAX);
    if !(0..len).contains(&source_start) || source_end > len || source_end - source_start <= 12 {
        return false;
    }
    let glyf = &mut source[source_start as usize..source_end as usize];
    let glyf_len = glyf.len() as i64;
    let x_min = glyph_signed16(glyf, 2);
    let y_min = glyph_signed16(glyf, 4);
    let x_max = glyph_signed16(glyf, 6);
    let y_max = glyph_signed16(glyf, 8);
    if x_min > x_max {
        glyf[2..4].copy_from_slice(&(x_max as i16).to_be_bytes());
        glyf[6..8].copy_from_slice(&(x_min as i16).to_be_bytes());
    }
    if y_min > y_max {
        glyf[4..6].copy_from_slice(&(y_max as i16).to_be_bytes());
        glyf[8..10].copy_from_slice(&(y_min as i16).to_be_bytes());
    }
    let contours_count = glyph_signed16(glyf, 0);
    if contours_count < 0 {
        return contours_count >= -1;
    }
    let mut j: i64 = 10;
    let mut flags_count: i64 = 0;
    for _ in 0..contours_count {
        flags_count = ((glyph_bits(glyf, j) << 8) | glyph_bits(glyf, j + 1)) + 1;
        j += 2;
    }
    let instructions_length = (glyph_bits(glyf, j) << 8) | glyph_bits(glyf, j + 1);
    j += 2 + instructions_length;
    let mut coordinates_length: i64 = 0;
    let mut i: i64 = 0;
    while i < flags_count {
        let flag = glyph_bits(glyf, j);
        j += 1;
        if flag & 0xc0 != 0
            && let Some(slot) = usize::try_from(j - 1).ok().and_then(|k| glyf.get_mut(k))
        {
            *slot = (flag & 0x3f) as u8;
        }
        let x_length = if flag & 2 != 0 {
            1
        } else if flag & 16 != 0 {
            0
        } else {
            2
        };
        let y_length = if flag & 4 != 0 {
            1
        } else if flag & 32 != 0 {
            0
        } else {
            2
        };
        let xy_length = x_length + y_length;
        coordinates_length += xy_length;
        if flag & 8 != 0 {
            let repeat = glyph_byte(glyf, j).map(i64::from);
            j += 1;
            match repeat {
                // `undefined`: `i += undefined` is NaN, which ends the loop, and the lengths are NaN: pdf.js keeps
                // the glyph.
                None => return true,
                Some(0) => {
                    if let Some(slot) = usize::try_from(j - 1).ok().and_then(|k| glyf.get_mut(k)) {
                        *slot ^= 8;
                    }
                }
                Some(repeat) => {
                    i += repeat;
                    coordinates_length += repeat * xy_length;
                }
            }
        }
        i += 1;
    }
    coordinates_length != 0 && j + coordinates_length <= glyf_len
}

/// `sanitizeGlyphLocations`: for each glyph whether it ends up with no data in `glyf`. `loca` is the table's data
/// (zero-padded as pdf.js pads it), `glyf` a copy of the `glyf` data that is repaired in place.
fn sanitize_glyph_locations(
    loca: &[u8],
    mut glyf: Vec<u8>,
    num_glyphs: i32,
    is_long: bool,
) -> Result<Vec<bool>> {
    // `locaEntries.at(-2)` of fewer than two entries is `undefined`.
    let num_glyphs = usize::try_from(num_glyphs)
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            PdfError::Unknown("Cannot read properties of undefined (reading 'offset')".to_owned())
        })?;
    let item_size = if is_long { 4 } else { 2 };
    let item = |k: usize| i64::from(loca.get(k).copied().unwrap_or(0));
    let decode = |at: usize| -> i64 {
        if is_long {
            i64::from(
                ((item(at) << 24) | (item(at + 1) << 16) | (item(at + 2) << 8) | item(at + 3)) as i32,
            )
        } else {
            (item(at) << 9) | (item(at + 1) << 1)
        }
    };
    let glyf_len = i64::try_from(glyf.len()).unwrap_or(i64::MAX);
    let mut entries: Vec<LocaEntry> = (0..=num_glyphs)
        .map(|index| LocaEntry {
            index,
            offset: decode(index * item_size).min(glyf_len),
            end_offset: 0,
        })
        .collect();
    entries.sort_by_key(|e| e.offset);
    let offsets: Vec<i64> = entries.iter().map(|e| e.offset).collect();
    for (entry, next) in entries.iter_mut().zip(offsets.iter().skip(1)) {
        entry.end_offset = *next;
    }
    entries.sort_by_key(|e| e.index);
    let mut i = 0;
    while i < num_glyphs {
        if entries[i].offset != 0 || entries[i].end_offset != 0 {
            break;
        }
        let next_offset = entries[i + 1].offset;
        if next_offset != 0 {
            entries[i].end_offset = next_offset;
            break;
        }
        i += 1;
    }
    let last = &mut entries[num_glyphs - 1];
    if last.offset != 0 && last.end_offset == 0 {
        last.end_offset = glyf_len;
    }
    let dropped = prune_composite_glyph_cycles(&mut glyf, &entries, num_glyphs)?;
    let mut missing = Vec::with_capacity(num_glyphs);
    for (entry, dropped) in entries.iter().zip(dropped).take(num_glyphs) {
        let has_outline =
            !dropped && glyph_has_outline(&mut glyf, entry.offset, entry.end_offset);
        missing.push(!has_outline);
    }
    Ok(missing)
}
