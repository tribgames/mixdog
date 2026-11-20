//! Font data ported from pdf.js 6.4.299 (src/core/encodings.js, glyphlist.js, metrics.js, standard_fonts.js, unicode.js,
//! fonts_utils.js, core_utils.js, bidi.js, shared/util.js), and the small functions around the tables.
//!
//! The tables are generated from pdf.js's own objects by `benchmarks/rust-core/recorders/gen-pdfjs-font-data.mjs`; the
//! submodules `encodings`, `glyphlist`, `metrics`, `standard_fonts`, `unicode` and `pdfdoc` are that output and are not
//! edited by hand ([`GENERATED_FNV1A64`] is the hash of their text, checked by a test). A name table is sorted by name
//! and read by binary search; a code table is sorted by code. Where pdf.js depends on the key order of a table (the
//! first glyph name with a code point), the generator writes the derived table.

#[rustfmt::skip]
pub mod encodings;
#[rustfmt::skip]
pub mod glyphlist;
#[rustfmt::skip]
pub mod metrics;
#[rustfmt::skip]
pub mod pdfdoc;
#[rustfmt::skip]
pub mod standard_fonts;
#[rustfmt::skip]
pub mod unicode;

pub use metrics::{Metrics, font_flags};

/// FNV-1a (64 bit) of the generated files, in the order encodings, glyphlist, metrics, standard_fonts, unicode, pdfdoc,
/// with line ends as `\n`. Written by the generator.
pub const GENERATED_FNV1A64: &str = "44f32f785342ea36";

/// The value of `key` in a table sorted by name.
pub fn lookup<V: Copy>(table: &[(&str, V)], key: &str) -> Option<V> {
    table.binary_search_by(|entry| entry.0.cmp(key)).ok().map(|at| table[at].1)
}

/// Whether `key` is in a sorted name list.
pub fn contains_name(names: &[&str], key: &str) -> bool {
    names.binary_search(&key).is_ok()
}

/// The value of `code` in a table sorted by code.
pub fn lookup_code(table: &[(u32, u32)], code: u32) -> Option<u32> {
    table.binary_search_by(|entry| entry.0.cmp(&code)).ok().map(|at| table[at].1)
}

/// `getGlyphsUnicode()[name]`.
pub fn glyph_unicode(name: &str) -> Option<u32> {
    lookup(&glyphlist::GLYPHS_UNICODE, name)
}

/// `getDingbatsGlyphsUnicode()[name]`.
pub fn dingbats_glyph_unicode(name: &str) -> Option<u32> {
    lookup(&glyphlist::DINGBATS_GLYPHS_UNICODE, name)
}

/// The first glyph name of the glyph list (in pdf.js's key order) with this code point: what `recoverGlyphName` finds.
pub fn glyph_name_for_unicode(unicode: u32) -> Option<&'static str> {
    let table = &glyphlist::GLYPH_NAME_BY_UNICODE;
    table.binary_search_by(|entry| entry.0.cmp(&unicode)).ok().map(|at| table[at].1)
}

/// `getMetrics()[name]`.
pub fn metrics_of(name: &str) -> Option<Metrics> {
    lookup(&metrics::METRICS, name)
}

impl Metrics {
    /// The width of a glyph, `None` for a glyph the font has no width for (and for a fixed-width font, whose
    /// `defaultWidth` applies to every glyph).
    pub fn glyph_width(&self, glyph_name: &str) -> Option<u16> {
        match self {
            Metrics::Fixed(_) => None,
            Metrics::Glyphs(widths) => lookup(widths, glyph_name),
        }
    }
}

/// JavaScript's `\s` (the white space and line terminators of ECMAScript, which include U+FEFF and exclude U+0085).
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// JavaScript's `parseInt(text, 16)`: leading white space, an optional sign and `0x`, then the longest run of hex
/// digits. `None` is `NaN`.
fn parse_int_hex(text: &str) -> Option<i64> {
    let text = text.trim_start_matches(is_js_whitespace);
    let (negative, text) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let text = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or(text);
    let digits = text.bytes().take_while(|byte| byte.is_ascii_hexdigit()).count();
    if digits == 0 {
        return None;
    }
    let value = text[..digits].bytes().fold(0i64, |sum, byte| sum.saturating_mul(16).saturating_add(i64::from((byte as char).to_digit(16).unwrap_or(0))));
    Some(if negative { -value } else { value })
}

/// pdf.js `getUnicodeForGlyph(name, glyphsUnicodeMap)`: the code point of a glyph name from the table `glyphs`
/// (sorted by name), or of a `uniXXXX` / `uXXXX` to `uXXXXXX` name; `None` is pdf.js's -1.
pub fn get_unicode_for_glyph(name: &str, glyphs: &[(&str, u32)]) -> Option<u32> {
    if let Some(unicode) = lookup(glyphs, name) {
        return Some(unicode);
    }
    if name.is_empty() {
        return None;
    }
    let units: Vec<u16> = name.encode_utf16().collect();
    if units[0] != u16::from(b'u') {
        return None;
    }
    let from = if units.len() == 7 && units[1] == u16::from(b'n') && units[2] == u16::from(b'i') {
        3
    } else if (5..=7).contains(&units.len()) {
        1
    } else {
        return None;
    };
    let hex = String::from_utf16_lossy(&units[from..]);
    if hex != hex.to_uppercase() {
        return None;
    }
    let unicode = parse_int_hex(&hex)?;
    u32::try_from(unicode).ok()
}

/// pdf.js `mapSpecialUnicodeValues(code)`.
pub fn map_special_unicode_values(code: u32) -> u32 {
    if (0xfff0..=0xffff).contains(&code) {
        0
    } else if (0xf600..=0xf8ff).contains(&code) {
        lookup_code(&glyphlist::SPECIAL_PUA_SYMBOLS, code).filter(|mapped| *mapped != 0).unwrap_or(code)
    } else if code == 0x00ad {
        0x002d
    } else {
        code
    }
}

/// pdf.js `getUnicodeRangeFor(value, lastPosition)`: the index of the Unicode range holding `value` (the bit of the
/// OS/2 table), trying `last_position` first; `None` is -1.
pub fn get_unicode_range_for(value: u32, last_position: Option<usize>) -> Option<usize> {
    let in_range = |range: &[u32]| range.as_chunks::<2>().0.iter().any(|pair| value >= pair[0] && value <= pair[1]);
    if let Some(last) = last_position
        && unicode::UNICODE_RANGES.get(last).is_some_and(|range| in_range(range))
    {
        return Some(last);
    }
    unicode::UNICODE_RANGES.iter().position(|range| in_range(range))
}

/// pdf.js `getCharUnicodeCategory(char)`: which of the three classes the character falls in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CharCategory {
    pub is_whitespace: bool,
    pub is_zero_width_diacritic: bool,
    pub is_invisible_format_mark: bool,
}

fn in_ranges(table: &[(u32, u32)], ch: char) -> bool {
    let code = ch as u32;
    table
        .binary_search_by(|&(first, last)| {
            if code < first {
                std::cmp::Ordering::Greater
            } else if code > last {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// pdf.js `getCharUnicodeCategory`, which matches `/^(\s)|(\p{Mn})|(\p{Cf})$/u`: the leftmost match decides, so a text
/// is white space when it starts with white space, else a diacritic at its first nonspacing mark or, only when it
/// is its last character, a format mark.
pub fn get_char_unicode_category(text: &str) -> CharCategory {
    let mut category = CharCategory { is_whitespace: false, is_zero_width_diacritic: false, is_invisible_format_mark: false };
    let count = text.chars().count();
    for (at, ch) in text.chars().enumerate() {
        if at == 0 && is_js_whitespace(ch) {
            category.is_whitespace = true;
        } else if in_ranges(&unicode::NONSPACING_MARKS, ch) {
            category.is_zero_width_diacritic = true;
        } else if at + 1 == count && in_ranges(&unicode::FORMAT_CHARS, ch) {
            category.is_invisible_format_mark = true;
        } else {
            continue;
        }
        break;
    }
    category
}

/// pdf.js `normalizeUnicode(str)`: the compatibility characters of its class (ligature, presentation-form and
/// no-break characters) become their NFKC form. U+FB05 is rewritten through a map keyed by the whole run of
/// U+FB05 characters, which holds the run of one only: a longer run gives the text "undefined", as pdf.js does.
pub fn normalize_unicode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{fb05}' {
            let mut run = 1;
            while chars.next_if_eq(&'\u{fb05}').is_some() {
                run += 1;
            }
            out.push_str(if run == 1 { "\u{17f}t" } else { "undefined" });
        } else if let Ok(at) = unicode::NFKC_NORMALIZED.binary_search_by(|entry| entry.0.cmp(&ch)) {
            out.push_str(unicode::NFKC_NORMALIZED[at].1);
        } else {
            out.push(ch);
        }
    }
    out
}

/// The direction pdf.js `bidi()` reports for a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BidiDir {
    Ltr,
    Rtl,
    /// Vertical writing: the text is returned as it is.
    Ttb,
}

impl BidiDir {
    /// The name pdf.js gives it ("ltr", "rtl", "ttb").
    pub fn as_str(self) -> &'static str {
        match self {
            BidiDir::Ltr => "ltr",
            BidiDir::Rtl => "rtl",
            BidiDir::Ttb => "ttb",
        }
    }
}

/// pdf.js `bidi()`'s result: the text in visual order (as UTF-16 code units, which is what pdf.js reorders) and its
/// direction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BidiText {
    pub units: Vec<u16>,
    pub dir: BidiDir,
}

impl BidiText {
    /// The text as a string (a surrogate the reordering separated from its pair becomes U+FFFD).
    pub fn text(&self) -> String {
        String::from_utf16_lossy(&self.units)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BidiType {
    L,
    R,
    Al,
    En,
    Es,
    Et,
    An,
    Cs,
    Nsm,
    Bn,
    B,
    S,
    Ws,
    On,
    /// A code point the Arabic table has no type for (pdf.js keeps the empty string, which no rule matches).
    Unknown,
}

fn bidi_type(name: &str) -> BidiType {
    match name {
        "L" => BidiType::L,
        "R" => BidiType::R,
        "AL" => BidiType::Al,
        "EN" => BidiType::En,
        "ES" => BidiType::Es,
        "ET" => BidiType::Et,
        "AN" => BidiType::An,
        "CS" => BidiType::Cs,
        "NSM" => BidiType::Nsm,
        "BN" => BidiType::Bn,
        "B" => BidiType::B,
        "S" => BidiType::S,
        "WS" => BidiType::Ws,
        "ON" => BidiType::On,
        _ => BidiType::Unknown,
    }
}

fn is_odd(level: i32) -> bool {
    level & 1 != 0
}

fn find_unequal(types: &[BidiType], start: usize, value: BidiType) -> usize {
    types[start.min(types.len())..].iter().position(|t| *t != value).map_or(types.len(), |at| start + at)
}

/// The type of the nearest strong character on one side, as the neutral-resolution rule reads it.
fn strong_side(t: BidiType) -> Option<BidiType> {
    match t {
        BidiType::L => Some(BidiType::L),
        BidiType::R | BidiType::En | BidiType::An => Some(BidiType::R),
        _ => None,
    }
}

/// pdf.js `bidi(str, startLevel, vertical)`: the text in visual order and its direction. `start_level` is `None` for
/// pdf.js's -1 (chosen from the share of right-to-left characters). Ported as written, on UTF-16 code units, so the
/// strings it returns match pdf.js's.
pub fn bidi(text: &[u16], start_level: Option<i32>, vertical: bool) -> BidiText {
    let len = text.len();
    if len == 0 || vertical {
        return BidiText { units: text.to_vec(), dir: if vertical { BidiDir::Ttb } else { BidiDir::Ltr } };
    }
    let mut chars: Vec<u16> = text.to_vec();
    let mut types: Vec<BidiType> = Vec::with_capacity(len);
    let mut num_bidi = 0usize;
    for &code in text {
        let mut char_type = BidiType::L;
        if code <= 0x00ff {
            char_type = bidi_type(unicode::BIDI_BASE_TYPES[usize::from(code)]);
        } else if (0x0590..=0x05f4).contains(&code) {
            char_type = BidiType::R;
        } else if (0x0600..=0x06ff).contains(&code) {
            char_type = bidi_type(unicode::BIDI_ARABIC_TYPES[usize::from(code & 0xff)]);
            if char_type == BidiType::Unknown {
                tracing::warn!("Bidi: invalid Unicode character {code:x}");
            }
        } else if (0x0700..=0x08ac).contains(&code) || (0xfb50..=0xfdff).contains(&code) || (0xfe70..=0xfeff).contains(&code) {
            char_type = BidiType::Al;
        }
        if matches!(char_type, BidiType::R | BidiType::Al | BidiType::An) {
            num_bidi += 1;
        }
        types.push(char_type);
    }
    if num_bidi == 0 {
        return BidiText { units: text.to_vec(), dir: BidiDir::Ltr };
    }
    let (is_ltr, start_level) = match start_level {
        Some(level) => (true, level),
        None if (num_bidi as f64) / (len as f64) < 0.3 && len > 4 => (true, 0),
        None => (false, 1),
    };
    // pdf.js sets isLTR only when it chooses the level itself; a level given by the caller keeps it true.
    let mut levels = vec![start_level; len];
    let e = if is_odd(start_level) { BidiType::R } else { BidiType::L };
    let sor = e;
    let eor = sor;

    let mut last_type = sor;
    for t in types.iter_mut() {
        if *t == BidiType::Nsm {
            *t = last_type;
        } else {
            last_type = *t;
        }
    }
    last_type = sor;
    for t in types.iter_mut() {
        if *t == BidiType::En {
            *t = if last_type == BidiType::Al { BidiType::An } else { BidiType::En };
        } else if matches!(*t, BidiType::R | BidiType::L | BidiType::Al) {
            last_type = *t;
        }
    }
    for t in types.iter_mut() {
        if *t == BidiType::Al {
            *t = BidiType::R;
        }
    }
    for i in 1..len.saturating_sub(1) {
        if types[i] == BidiType::Es && types[i - 1] == BidiType::En && types[i + 1] == BidiType::En {
            types[i] = BidiType::En;
        }
        if types[i] == BidiType::Cs && matches!(types[i - 1], BidiType::En | BidiType::An) && types[i + 1] == types[i - 1] {
            types[i] = types[i - 1];
        }
    }
    for i in 0..len {
        if types[i] == BidiType::En {
            for t in types[..i].iter_mut().rev().take_while(|t| **t == BidiType::Et) {
                *t = BidiType::En;
            }
            for t in types[i + 1..].iter_mut().take_while(|t| **t == BidiType::Et) {
                *t = BidiType::En;
            }
        }
    }
    for t in types.iter_mut() {
        if matches!(*t, BidiType::Ws | BidiType::Es | BidiType::Et | BidiType::Cs) {
            *t = BidiType::On;
        }
    }
    last_type = sor;
    for t in types.iter_mut() {
        if *t == BidiType::En {
            *t = if last_type == BidiType::L { BidiType::L } else { BidiType::En };
        } else if matches!(*t, BidiType::R | BidiType::L) {
            last_type = *t;
        }
    }
    let mut i = 0;
    while i < len {
        if types[i] == BidiType::On {
            let end = find_unequal(&types, i + 1, BidiType::On);
            let before = types[..i].iter().rev().find_map(|t| strong_side(*t)).unwrap_or(sor);
            let after = types[end..].iter().find_map(|t| strong_side(*t)).unwrap_or(eor);
            if before == after {
                types[i..end].fill(before);
            }
            i = end - 1;
        }
        i += 1;
    }
    for t in types.iter_mut() {
        if *t == BidiType::On {
            *t = e;
        }
    }
    for (level, t) in levels.iter_mut().zip(&types) {
        if *level & 1 == 0 {
            if *t == BidiType::R {
                *level += 1;
            } else if matches!(*t, BidiType::An | BidiType::En) {
                *level += 2;
            }
        } else if matches!(*t, BidiType::L | BidiType::An | BidiType::En) {
            *level += 1;
        }
    }
    let mut highest_level = -1;
    let mut lowest_odd_level = 99;
    for &level in &levels {
        highest_level = highest_level.max(level);
        if lowest_odd_level > level && is_odd(level) {
            lowest_odd_level = level;
        }
    }
    let mut level = highest_level;
    while level >= lowest_odd_level {
        let mut start: Option<usize> = None;
        for i in 0..len {
            if levels[i] < level {
                if let Some(from) = start.take() {
                    chars[from..i].reverse();
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        if let Some(from) = start {
            chars[from..len].reverse();
        }
        level -= 1;
    }
    chars.retain(|&c| c != u16::from(b'<') && c != u16::from(b'>'));
    BidiText { units: chars, dir: if is_ltr { BidiDir::Ltr } else { BidiDir::Rtl } }
}

/// Removes pdf.js's escape sequences (`/\x1b[^\x1b]*(?:\x1b|$)/g`) from a decoded string.
fn strip_escape_sequences(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut skipping = false;
    for ch in text.chars() {
        if ch == '\u{1b}' {
            skipping = !skipping;
        } else if !skipping {
            out.push(ch);
        }
    }
    out
}

fn decode_utf16(bytes: &[u8], big_endian: bool) -> Option<String> {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| if big_endian { u16::from_be_bytes([pair[0], pair[1]]) } else { u16::from_le_bytes([pair[0], pair[1]]) })
        .collect();
    String::from_utf16(&units).ok()
}

/// pdf.js `stringToPDFString(str, keepEscapeSequence)`: a PDF text string (a UTF-16BE, UTF-16LE or UTF-8 string led
/// by its byte order mark, otherwise PDFDocEncoding) as text. A byte order mark whose text is malformed falls back to
/// PDFDocEncoding over the bytes, with the warning pdf.js logs.
pub fn string_to_pdf_string(bytes: &[u8], keep_escape_sequence: bool) -> String {
    let mut bytes = bytes;
    if bytes.first().is_some_and(|first| *first >= 0xef) {
        let mut decoded = None;
        let mut encoding = "";
        if bytes.starts_with(&[0xfe, 0xff]) {
            encoding = "utf-16be";
            if bytes.len() % 2 == 1 {
                bytes = &bytes[..bytes.len() - 1];
            }
            decoded = decode_utf16(&bytes[2..], true);
        } else if bytes.starts_with(&[0xff, 0xfe]) {
            encoding = "utf-16le";
            if bytes.len() % 2 == 1 {
                bytes = &bytes[..bytes.len() - 1];
            }
            decoded = decode_utf16(&bytes[2..], false);
        } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            encoding = "utf-8";
            decoded = String::from_utf8(bytes[3..].to_vec()).ok();
        }
        if let Some(text) = decoded {
            return if keep_escape_sequence || !text.contains('\u{1b}') { text } else { strip_escape_sequences(&text) };
        }
        if !encoding.is_empty() {
            tracing::warn!("stringToPDFString: the {encoding} text is malformed.");
        }
    }
    let mut out = String::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if !keep_escape_sequence && byte == 0x1b {
            at += 1;
            while at < bytes.len() && bytes[at] != 0x1b {
                at += 1;
            }
            at += 1;
            continue;
        }
        let mapped =
            pdfdoc::PDF_STRING_TRANSLATE_TABLE.get(usize::from(byte)).copied().filter(|code| *code != 0).and_then(|code| char::from_u32(u32::from(code)));
        out.push(mapped.unwrap_or(char::from(byte)));
        at += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn fnv1a(text: &str) -> u64 {
        text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3))
    }

    #[test]
    fn generated_files_match_the_recorded_hash() {
        let files = [
            include_str!("encodings.rs"),
            include_str!("glyphlist.rs"),
            include_str!("metrics.rs"),
            include_str!("standard_fonts.rs"),
            include_str!("unicode.rs"),
            include_str!("pdfdoc.rs"),
        ];
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for file in files {
            for byte in file.replace('\r', "").bytes() {
                hash = (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        assert_eq!(format!("{hash:016x}"), GENERATED_FNV1A64);
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
    }

    #[test]
    fn tables_are_sorted_for_binary_search() {
        fn sorted<T: Ord>(items: impl Iterator<Item = T>) -> bool {
            let items: Vec<T> = items.collect();
            items.windows(2).all(|pair| pair[0] < pair[1])
        }
        assert!(sorted(glyphlist::GLYPHS_UNICODE.iter().map(|e| e.0)));
        assert!(sorted(glyphlist::DINGBATS_GLYPHS_UNICODE.iter().map(|e| e.0)));
        assert!(sorted(glyphlist::GLYPH_NAME_BY_UNICODE.iter().map(|e| e.0)));
        assert!(sorted(glyphlist::SPECIAL_PUA_SYMBOLS.iter().map(|e| e.0)));
        assert!(sorted(metrics::METRICS.iter().map(|e| e.0)));
        for (_, entry) in metrics::METRICS.iter() {
            if let Metrics::Glyphs(widths) = entry {
                assert!(sorted(widths.iter().map(|e| e.0)));
            }
        }
        assert!(sorted(standard_fonts::STD_FONT_MAP.iter().map(|e| e.0)));
        assert!(sorted(standard_fonts::NON_STD_FONT_MAP.iter().map(|e| e.0)));
        assert!(sorted(standard_fonts::SERIF_FONTS.iter()));
        assert!(sorted(standard_fonts::SYMBOLS_FONTS.iter()));
        assert!(sorted(standard_fonts::FONT_NAME_TO_FILE.iter().map(|e| e.0)));
        assert!(sorted(standard_fonts::GLYPH_MAP_FOR_STANDARD_FONTS.iter().map(|e| e.0)));
        assert!(sorted(unicode::VERTICAL_PRESENTATION_FORM.iter().map(|e| e.0)));
        assert!(sorted(unicode::NFKC_NORMALIZED.iter().map(|e| e.0)));
    }

    #[test]
    fn table_sizes_match_pdf_js() {
        assert_eq!(glyphlist::GLYPHS_UNICODE.len(), 4328);
        assert_eq!(glyphlist::DINGBATS_GLYPHS_UNICODE.len(), 203);
        assert_eq!(glyphlist::SPECIAL_PUA_SYMBOLS.len(), 27);
        assert_eq!(metrics::METRICS.len(), 14);
        assert_eq!(standard_fonts::STD_FONT_MAP.len(), 72);
        assert_eq!(standard_fonts::NON_STD_FONT_MAP.len(), 50);
        assert_eq!(standard_fonts::SERIF_FONTS.len(), 134);
        assert_eq!(standard_fonts::SYMBOLS_FONTS.len(), 6);
        assert_eq!(standard_fonts::FONT_NAME_TO_FILE.len(), 18);
        assert_eq!(standard_fonts::GLYPH_MAP_FOR_MAC_ORDERED_FONTS.len(), 256);
        assert_eq!(standard_fonts::GLYPH_MAP_FOR_STANDARD_FONTS.len(), 496);
        assert_eq!(standard_fonts::SUPPLEMENTAL_GLYPH_MAP_FOR_TREBUCHET_MS.len(), 75);
        assert_eq!(standard_fonts::SUPPLEMENTAL_GLYPH_MAP_FOR_ARIAL_BLACK.len(), 3);
        assert_eq!(standard_fonts::SUPPLEMENTAL_GLYPH_MAP_FOR_CALIBRI.len(), 117);
        assert_eq!(unicode::VERTICAL_PRESENTATION_FORM.len(), 33);
        assert_eq!(unicode::UNICODE_RANGES.len(), 123);
        assert_eq!(pdfdoc::PDF_STRING_TRANSLATE_TABLE.len(), 161);
        assert_eq!(encodings::MAC_STANDARD_GLYPH_ORDERING.len(), 258);
        assert_eq!(encodings::SYMBOL_GLYPH_ID_ENCODING.len(), 192);
    }

    #[test]
    fn encodings_and_glyph_names() {
        let win = encodings::get_encoding("WinAnsiEncoding").unwrap();
        assert_eq!(win[0x41], "A");
        assert_eq!(win[0x80], "Euro");
        assert_eq!(encodings::STANDARD_ENCODING[0x27], "quoteright");
        assert_eq!(encodings::MAC_ROMAN_ENCODING[0x80], "Adieresis");
        assert_eq!(encodings::SYMBOL_SET_ENCODING[0x61], "alpha");
        assert_eq!(encodings::ZAPF_DINGBATS_ENCODING[0x21], "a1");
        assert_eq!(encodings::SYMBOL_GLYPH_ID_ENCODING[3], "space");
        assert_eq!(encodings::SYMBOL_GLYPH_ID_ENCODING[0], "");
        assert!(encodings::get_encoding("Identity-H").is_none());
        assert_eq!(glyph_unicode("A"), Some(0x41));
        assert_eq!(glyph_unicode("AEacute"), Some(0x1fc));
        assert_eq!(glyph_unicode("nosuchglyph"), None);
        assert_eq!(dingbats_glyph_unicode("a1"), Some(0x2701));
        assert_eq!(glyph_name_for_unicode(0x41), Some("A"));
    }

    #[test]
    fn metrics_and_font_maps() {
        assert_eq!(metrics_of("Courier"), Some(Metrics::Fixed(600)));
        let helvetica = metrics_of("Helvetica").unwrap();
        assert_eq!(helvetica.glyph_width("space"), Some(278));
        assert_eq!(helvetica.glyph_width("quotedbl"), Some(355));
        assert_eq!(metrics_of("Times-Roman").unwrap().glyph_width("space"), Some(250));
        assert_eq!(metrics_of("Symbol").unwrap().glyph_width("alpha"), Some(631));
        assert!(metrics_of("Arial").is_none());
        assert_eq!(font_flags::FIXED_PITCH, 1);
        assert_eq!(font_flags::NONSYMBOLIC, 32);
        assert_eq!(font_flags::FORCE_BOLD, 262144);
        assert_eq!(lookup(&standard_fonts::STD_FONT_MAP, "Helvetica"), Some("Helvetica"));
        assert!(contains_name(&standard_fonts::SYMBOLS_FONTS, "Wingdings-Bold"));
        assert!(!contains_name(&standard_fonts::SYMBOLS_FONTS, "Arial"));
        assert_eq!(lookup_code(&standard_fonts::GLYPH_MAP_FOR_STANDARD_FONTS, 3), Some(32));
        assert_eq!(lookup_code(&unicode::VERTICAL_PRESENTATION_FORM, 0x2014), Some(0xfe31));
    }

    #[test]
    fn unicode_for_glyph_names() {
        let glyphs = &glyphlist::GLYPHS_UNICODE;
        assert_eq!(get_unicode_for_glyph("A", glyphs), Some(0x41));
        assert_eq!(get_unicode_for_glyph("uni20AC", glyphs), Some(0x20ac));
        assert_eq!(get_unicode_for_glyph("u20AC", glyphs), Some(0x20ac));
        assert_eq!(get_unicode_for_glyph("u1F600", glyphs), Some(0x1f600));
        assert_eq!(get_unicode_for_glyph("uni20ac", glyphs), None);
        assert_eq!(get_unicode_for_glyph("uni20", glyphs), None);
        assert_eq!(get_unicode_for_glyph("", glyphs), None);
        assert_eq!(get_unicode_for_glyph("xyz", glyphs), None);
        // parseInt reads the leading hex digits and ignores the rest, and takes a sign and a 0X prefix.
        assert_eq!(get_unicode_for_glyph("u12G4", glyphs), Some(0x12));
        assert_eq!(get_unicode_for_glyph("uZZZZ", glyphs), None);
        assert_eq!(get_unicode_for_glyph("u+12AB", glyphs), Some(0x12ab));
        assert_eq!(get_unicode_for_glyph("u-12AB", glyphs), None);
        assert_eq!(get_unicode_for_glyph("u0X1F", glyphs), Some(0x1f));
        assert_eq!(get_unicode_for_glyph("u 12AB", glyphs), Some(0x12ab));
        assert_eq!(get_unicode_for_glyph("u-0000", glyphs), Some(0));
        assert_eq!(get_unicode_for_glyph("u12\u{1f600}", glyphs), Some(0x12));
        assert_eq!(map_special_unicode_values(0xfff5), 0);
        assert_eq!(map_special_unicode_values(0x00ad), 0x2d);
        assert_eq!(map_special_unicode_values(63721), 0xa9);
        assert_eq!(map_special_unicode_values(0xf700), 0xf700);
        assert_eq!(map_special_unicode_values(0x41), 0x41);
        assert_eq!(get_unicode_range_for(0x41, None), Some(0));
        assert_eq!(get_unicode_range_for(0xe9, Some(0)), Some(1));
        assert_eq!(get_unicode_range_for(0x41, Some(0)), Some(0));
        assert_eq!(get_unicode_range_for(0x5d0, None), Some(11));
        assert_eq!(get_unicode_range_for(0x10ffff, None), None);
        assert_eq!(get_unicode_range_for(0x20ac, None), Some(33));
        assert_eq!(get_unicode_range_for(0x4e00, None), Some(59));
    }

    #[test]
    fn character_categories() {
        let category = |text: &str| {
            let c = get_char_unicode_category(text);
            (c.is_whitespace, c.is_zero_width_diacritic, c.is_invisible_format_mark)
        };
        assert_eq!(category(" "), (true, false, false));
        assert_eq!(category("\u{a0}"), (true, false, false));
        assert_eq!(category("\u{85}"), (false, false, false));
        assert_eq!(category("\u{feff}"), (true, false, false));
        assert_eq!(category("\u{301}"), (false, true, false));
        assert_eq!(category("\u{200b}"), (false, false, true));
        assert_eq!(category("a\u{200b}"), (false, false, true));
        assert_eq!(category("\u{200b}a"), (false, false, false));
        assert_eq!(category("a\u{301}b"), (false, true, false));
        assert_eq!(category("a"), (false, false, false));
        assert_eq!(category(""), (false, false, false));
        assert_eq!(category("\u{2028}"), (true, false, false));
        assert_eq!(category("\u{180e}"), (false, false, true));
        assert_eq!(category(" \u{301}"), (true, false, false));
    }

    #[test]
    fn unicode_normalisation() {
        assert_eq!(normalize_unicode("a\u{fb01}b"), "afib");
        assert_eq!(normalize_unicode("x\u{fb03}"), "xffi");
        assert_eq!(normalize_unicode("\u{a0}\u{2003}"), "  ");
        assert_eq!(normalize_unicode("\u{fb05}"), "\u{17f}t");
        assert_eq!(normalize_unicode("\u{fb05}\u{fb05}"), "undefined");
        assert_eq!(normalize_unicode("\u{fb05}a\u{fb05}"), "\u{17f}ta\u{17f}t");
        assert_eq!(normalize_unicode("\u{fb00}\u{fb05}\u{fb01}"), "ff\u{17f}tfi");
        assert_eq!(normalize_unicode("plain"), "plain");
        assert_eq!(normalize_unicode("\u{2126}"), "\u{3a9}");
    }

    #[test]
    fn pdf_strings() {
        assert_eq!(string_to_pdf_string(b"abc", false), "abc");
        assert_eq!(string_to_pdf_string(&[0x18, 0x1f, 0x80, 0x95, 0x9f, 0xa0, 0xad, 0xff], false), "\u{2d8}\u{2dc}\u{2022}\u{141}\u{9f}\u{20ac}\u{ad}\u{ff}");
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff, 0x00, 0x41, 0x20, 0xac], false), "A\u{20ac}");
        assert_eq!(string_to_pdf_string(&[0xff, 0xfe, 0x41, 0x00], false), "A");
        assert_eq!(string_to_pdf_string(&[0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac], false), "\u{20ac}");
        // an odd byte count loses the last byte
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff, 0x00, 0x41, 0x00], false), "A");
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff], false), "");
        assert_eq!(string_to_pdf_string(&[0xfe], false), "\u{fe}");
        // a malformed text under a byte order mark falls back to PDFDocEncoding over the bytes
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff, 0xd8, 0x00], false), "\u{fe}\u{ff}\u{d8}\u{0}");
        assert_eq!(string_to_pdf_string(&[0xef, 0xbb, 0xbf, 0xff], false), "\u{ef}\u{bb}\u{bf}\u{ff}");
        // escape sequences (language tags) are dropped unless kept
        assert_eq!(string_to_pdf_string(b"a\x1b(en)\x1bb", false), "ab");
        assert_eq!(string_to_pdf_string(b"a\x1b(en)\x1bb", true), "a\u{2d9}(en)\u{2d9}b");
        assert_eq!(string_to_pdf_string(b"a\x1bxyz", false), "a");
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff, 0, 0x61, 0, 0x1b, 0, 0x62, 0, 0x1b, 0, 0x63], false), "ac");
        assert_eq!(string_to_pdf_string(&[0xfe, 0xff, 0, 0x61, 0, 0x1b, 0, 0x62, 0, 0x1b, 0, 0x63], true), "a\u{1b}b\u{1b}c");
        assert_eq!(string_to_pdf_string(&[0xff, 0xfe, 0x1b, 0, 0x61, 0], false), "");
        assert_eq!(string_to_pdf_string(&[0xff, 0xfe, 0x1b, 0, 0x61, 0, 0x1b, 0, 0x62, 0], false), "b");
        assert_eq!(string_to_pdf_string(b"", false), "");
    }

    fn visual(text: &str, start_level: Option<i32>, vertical: bool) -> (String, &'static str) {
        let result = bidi(&utf16(text), start_level, vertical);
        (result.text(), result.dir.as_str())
    }

    #[test]
    fn bidi_orders_text_like_pdf_js() {
        // every expectation below is what pdf.js 6.4.299's bidi() returned for the same input
        let cases: &[(&str, &str, &str)] = &[
            ("", "", "ltr"),
            ("abc", "abc", "ltr"),
            ("\u{5d0}\u{5d1}\u{5d2}", "\u{5d2}\u{5d1}\u{5d0}", "rtl"),
            ("ab \u{5d0}\u{5d1} cd", "ab \u{5d1}\u{5d0} cd", "ltr"),
            ("<\u{5d0}>", "\u{5d0}", "rtl"),
            ("\u{5d0} 123 \u{5d1}", "\u{5d1} 123 \u{5d0}", "ltr"),
            ("abc 123 \u{627}\u{644}\u{639}", "abc 123 \u{639}\u{644}\u{627}", "ltr"),
            ("\u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629} 123", "123 \u{629}\u{64a}\u{628}\u{631}\u{639}\u{644}\u{627}", "rtl"),
            ("1,234 \u{5d0}", "1,234 \u{5d0}", "ltr"),
            ("\u{5d0}-5%", "5%-\u{5d0}", "rtl"),
            ("\u{5d0}\u{1f600}\u{5d1}", "\u{5d1}\u{1f600}\u{5d0}", "rtl"),
            ("\u{605}\u{5d0}", "\u{5d0}\u{605}", "rtl"),
            ("\u{670}\u{627}", "\u{627}\u{670}", "rtl"),
            ("a\u{5d0}b\u{5d1}c\u{5d2}d\u{5d3}e", "e\u{5d3}d\u{5d2}c\u{5d1}b\u{5d0}a", "rtl"),
        ];
        for (input, expected, dir) in cases {
            assert_eq!(visual(input, None, false), (expected.to_string(), *dir), "bidi of {input:?}");
        }
        assert_eq!(visual("ab \u{5d0}\u{5d1}", Some(0), false), ("ab \u{5d1}\u{5d0}".into(), "ltr"));
        assert_eq!(visual("ab \u{5d0}\u{5d1}", Some(1), false), ("\u{5d1}\u{5d0} ab".into(), "ltr"));
        assert_eq!(visual("abc", None, true), ("abc".into(), "ttb"));
    }
}
