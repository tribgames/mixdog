//! The fonts of a rendered page: [`PageFonts`] is the [`FontProvider`] of the operator-list pass (pdf.js
//! `PartialEvaluator.translateFont`: the font object of a font dictionary, with `charsToGlyphs` and `bbox`) and the
//! [`FontDrawing`] of the rasteriser (`commonObjs.get(loadedName)` and `font.getPathGenerator`: the font loaded under a
//! name and the outline of a glyph).
//!
//! The font object is the one the text reader already makes ([`FontLoader`]: widths, encodings, ToUnicode, the standard
//! 14 metrics). What pdf.js does to the font program besides that, `checkAndRepair` and `convert` rebuilding it into an
//! OpenType file whose `cmap` is keyed by the character codes of the font, is done here as a table from character code
//! to glyph id of the program as it is, in the order pdf.js builds its own `cmap`:
//!
//! * TrueType and OpenType with `glyf`: a CID font reaches the glyph by its CID (through the `CIDToGIDMap` when there
//!   is one), a simple font through the `cmap` subtable pdf.js chooses (`readCmapTable`) and the glyph names of the
//!   encoding (`checkAndRepair`), then the `post` names;
//! * CFF (bare or in OpenType) and Type 1: a CID font by the charset, a simple font by the glyph names of the encoding
//!   (`type1FontGlyphMapping`);
//! * a font without a program of its own (the standard 14 and what is substituted for any other name) by the code
//!   point its character stands for (`toFontChar`), in the bundled substitute face pdf.js draws for it
//!   (`standardFontDataUrl`: Liberation Sans for Helvetica, the Foxit faces for Courier and Times);
//! * Type 3 fonts draw their glyph procedures through [`crate::oplist::Type3Data`], not here.
//!
//! A font whose program cannot be read draws nothing and is reported once (pdf.js's `ErrorFont` for a font that cannot
//! be made at all, a warning for one whose outlines cannot be built). The outlines are paths in em units (the font
//! matrix applied), as `crate::glyph::FontRenderer` makes them.
//!
//! One `PageFonts` serves the pages of one document one at a time: the names the evaluator gives fonts (`f1`, `f2`)
//! restart for each page, and a name stands for the font of the page being drawn.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::fontfile::cff::{CffProperties, CharsetEntry, read_cff_font};
use crate::fontfile::truetype::{CmapTable, GlyphInfo, TrueTypeFont as SfntFile};
use crate::fonts::data::{
    self,
    encodings::{MAC_ROMAN_ENCODING, STANDARD_ENCODING, get_encoding},
    font_flags,
    standard_fonts::{NON_STD_FONT_MAP, STD_FONT_MAP},
};
use crate::fonts::font::{Font, FontKind, FontLoader, LoadContext, NoType3Scan, TranslatedFont};
use crate::fonts::to_unicode::UniValue;
use crate::fonts::widths::normalize_font_name;
use crate::glyph::substitute::{StandardFonts, standard_font_name};
use crate::glyph::type1::{Type1Font, Type1Options};
use crate::glyph::type2::parse_cff;
use crate::glyph::{CmapRange, FONT_IDENTITY_MATRIX, FontRenderer};
use crate::object::{Dict, Obj};
use crate::oplist::{FontObject, FontProvider, Glyph};
use crate::render::{DrawnFont, FontDrawing, GlyphDraw};
use crate::xref::Xref;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How a character code reaches a glyph of the program.
enum Mapping {
    /// A table from character code to glyph id (simple fonts).
    Codes(HashMap<u32, u16>),
    /// Through the CMap of a CID font to a CID, then to a glyph id.
    Cid(CidToGid),
    /// By the code point the character stands for (a font drawn in a substitute face).
    Unicode(Arc<HashMap<u32, u16>>),
}

enum CidToGid {
    /// The CID is the glyph id.
    Identity,
    /// The `CIDToGIDMap` of the font.
    Map(BTreeMap<u32, u32>),
    /// The charset of a CID-keyed CFF program (or the glyph order of a Type 1 one).
    Charset(HashMap<u32, u16>),
}

struct Outlines {
    renderer: Arc<Mutex<FontRenderer>>,
    mapping: Mapping,
}

/// What drawing keeps of a font: the glyph outlines by character code.
struct DrawFont {
    drawn: DrawnFont,
    font: Arc<TranslatedFont>,
    outlines: Option<Outlines>,
    paths: Mutex<HashMap<u32, Option<Arc<Vec<f32>>>>>,
    reported: Mutex<bool>,
}

impl DrawFont {
    fn warn_once(&self, message: &str) {
        let mut reported = lock(&self.reported);
        if !*reported {
            *reported = true;
            tracing::warn!("{message}");
        }
    }

    fn glyph_id(&self, outlines: &Outlines, code: u32) -> Option<u16> {
        match &outlines.mapping {
            Mapping::Codes(table) => table.get(&code).copied(),
            Mapping::Unicode(table) => {
                let font = self.font.font()?;
                table.get(&font.font_char_code(code)).copied()
            }
            Mapping::Cid(cid_to_gid) => {
                let font = self.font.font()?;
                let cid = u32::try_from(font.cid_of(code)?).ok()?;
                match cid_to_gid {
                    CidToGid::Identity => u16::try_from(cid).ok(),
                    CidToGid::Map(map) => map.get(&cid).and_then(|gid| u16::try_from(*gid).ok()),
                    CidToGid::Charset(map) => map.get(&cid).copied(),
                }
            }
        }
    }

    fn path(&self, code: u32) -> Option<Arc<Vec<f32>>> {
        if let Some(found) = lock(&self.paths).get(&code) {
            return found.clone();
        }
        let path = self.outline(code);
        lock(&self.paths).insert(code, path.clone());
        path
    }

    fn outline(&self, code: u32) -> Option<Arc<Vec<f32>>> {
        let outlines = self.outlines.as_ref()?;
        let glyph_id = self.glyph_id(outlines, code)?;
        let path = lock(&outlines.renderer).glyph_path(glyph_id);
        match path {
            Ok(path) if !path.is_empty() => Some(Arc::new(path)),
            Ok(_) => None,
            Err(error) => {
                self.warn_once(&format!("font \"{}\": a glyph outline cannot be drawn: {error}", self.font.font().map_or("", |font| font.name.as_str())));
                None
            }
        }
    }
}

/// The font object the evaluator holds: the glyphs of a string.
struct BridgedFont {
    draw: Arc<DrawFont>,
}

impl FontObject for BridgedFont {
    fn is_type3(&self) -> bool {
        self.draw.drawn.type3
    }

    fn chars_to_glyphs(&self, chars: &[u8]) -> Vec<Glyph> {
        let translated = &self.draw.font;
        let Some(font) = translated.font() else {
            return Vec::new();
        };
        translated
            .chars_to_glyphs(chars)
            .iter()
            .map(|glyph| {
                let text = String::from_utf16_lossy(&glyph.unicode);
                Glyph {
                    width: glyph.width,
                    original_char_code: glyph.original_char_code,
                    font_char: text.clone(),
                    unicode: text,
                    accent: None,
                    vmetric: glyph.vmetric,
                    operator_list_id: if font.is_type3_font { font.glyph_name(glyph.original_char_code).map(str::to_owned) } else { None },
                    is_space: glyph.is_space,
                    is_in_font: true,
                }
            })
            .collect()
    }

    fn bbox(&self) -> [f64; 4] {
        self.draw.font.font().and_then(|font| font.bbox).unwrap_or([0.0; 4])
    }
}

#[derive(Default)]
struct Registry {
    /// The fonts made, by the address of the font the loader returned.
    made: HashMap<usize, Arc<DrawFont>>,
    /// The font objects handed to the evaluator that have not been named yet, by address.
    pending: HashMap<usize, Arc<DrawFont>>,
    /// The fonts of the page being drawn, by the name the evaluator gave them.
    by_name: HashMap<String, Arc<DrawFont>>,
}

/// The font provider and the font drawing of a document's rendered pages.
pub struct PageFonts {
    loader: FontLoader,
    registry: Mutex<Registry>,
}

impl PageFonts {
    /// The fonts of `document`'s pages: its font cache, its error policy.
    pub fn new(document: &Document) -> Self {
        PageFonts { loader: crate::text::font_loader(document), registry: Mutex::new(Registry::default()) }
    }

    fn draw_font(&self, translated: Arc<TranslatedFont>) -> Arc<DrawFont> {
        let key = Arc::as_ptr(&translated) as usize;
        if let Some(made) = lock(&self.registry).made.get(&key) {
            return Arc::clone(made);
        }
        let draw = Arc::new(build_draw_font(translated));
        lock(&self.registry).made.insert(key, Arc::clone(&draw));
        draw
    }
}

impl FontProvider for PageFonts {
    fn translate_font(&self, dict: &Arc<Dict>, xref: &Xref) -> Result<Arc<dyn FontObject>> {
        let resources = Dict::new();
        let type3_font_refs = HashSet::new();
        let context = LoadContext { type3_font_refs: &type3_font_refs, parsing_type3_font: false, type3: &NoType3Scan };
        let translated = self.loader.load_font(xref, None, Some(&Obj::Dict(Arc::clone(dict))), &resources, &context)?;
        if let FontKind::Error(error) = &translated.font {
            return Err(PdfError::Unknown(error.error.clone()));
        }
        let draw = self.draw_font(translated);
        let object: Arc<dyn FontObject> = Arc::new(BridgedFont { draw: Arc::clone(&draw) });
        lock(&self.registry).pending.insert(Arc::as_ptr(&object).cast::<()>() as usize, draw);
        Ok(object)
    }

    fn font_loaded(&self, loaded_name: &str, font: &Arc<dyn FontObject>) {
        let mut registry = lock(&self.registry);
        if let Some(draw) = registry.pending.remove(&(Arc::as_ptr(font).cast::<()>() as usize)) {
            registry.by_name.insert(loaded_name.to_owned(), draw);
        }
    }
}

impl FontDrawing for PageFonts {
    fn font(&self, loaded_name: &str) -> Option<DrawnFont> {
        lock(&self.registry).by_name.get(loaded_name).map(|draw| draw.drawn.clone())
    }

    fn glyph(&self, loaded_name: &str, glyph: &Glyph) -> GlyphDraw {
        let draw = lock(&self.registry).by_name.get(loaded_name).cloned();
        GlyphDraw { path: draw.and_then(|draw| draw.path(glyph.original_char_code)), accent: None }
    }
}

// ---- making a font ---------------------------------------------------------------------------------------------------

fn build_draw_font(translated: Arc<TranslatedFont>) -> DrawFont {
    let Some(font) = translated.font() else {
        return DrawFont {
            drawn: DrawnFont { font_matrix: FONT_IDENTITY_MATRIX, vertical: false, type3: false, missing_file: false },
            font: Arc::clone(&translated),
            outlines: None,
            paths: Mutex::new(HashMap::new()),
            reported: Mutex::new(false),
        };
    };
    let drawn = DrawnFont {
        font_matrix: usable_matrix(font.font_matrix).unwrap_or(FONT_IDENTITY_MATRIX),
        vertical: font.vertical,
        type3: font.is_type3_font,
        missing_file: font.missing_file,
    };
    let mut failure = None;
    let outlines = if font.is_type3_font {
        None
    } else {
        match build_outlines(font) {
            Ok(outlines) => Some(outlines),
            Err(message) => {
                failure = Some(message);
                None
            }
        }
    };
    let draw = DrawFont { drawn, font: Arc::clone(&translated), outlines, paths: Mutex::new(HashMap::new()), reported: Mutex::new(false) };
    if let Some(message) = failure {
        draw.warn_once(&format!("font \"{}\" draws nothing: {message}", font.name));
    }
    draw
}

/// A font matrix whose six numbers are all known.
fn usable_matrix(matrix: Option<[f64; 6]>) -> Option<[f64; 6]> {
    matrix.filter(|matrix| matrix.iter().all(|value| value.is_finite()) && matrix[0] != 0.0)
}

fn build_outlines(font: &Font) -> std::result::Result<Outlines, String> {
    let Some(program) = font.program.as_deref() else {
        return substitute_outlines(font);
    };
    let ty = font.ty.as_str();
    let subtype = font.subtype.as_deref();
    match ty {
        "TrueType" | "OpenType" | "CIDFontType2" => sfnt_outlines(font, program),
        "Type1" | "MMType1" | "CIDFontType0" => {
            if matches!(subtype, Some("Type1C" | "CIDFontType0C")) {
                cff_outlines(font, program)
            } else {
                type1_outlines(font, program)
            }
        }
        other => Err(format!("a font program of type {other} is not drawn")),
    }
}

fn be16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn sfnt_outlines(font: &Font, program: &[u8]) -> std::result::Result<Outlines, String> {
    let ttf = SfntFile::parse(program, &font.name).map_err(|error| error.to_string())?;
    if !ttf.is_true_type() {
        let cff = ttf.table_data("CFF ").ok_or_else(|| "no CFF table".to_owned())?;
        return cff_outlines(font, cff);
    }
    let table = |tag: &str| ttf.table_data(tag).ok_or_else(|| format!("the {tag} table is missing"));
    let (glyf, loca, head) = (table("glyf")?, table("loca")?, table("head")?);
    let units_per_em = be16(head, 18).unwrap_or(0);
    let long_offsets = be16(head, 50).unwrap_or(0) != 0;
    let renderer = FontRenderer::from_glyf(glyf, loca, long_offsets, units_per_em, usable_matrix(font.font_matrix)).map_err(|error| error.to_string())?;
    let mapping = if font.composite {
        Mapping::Cid(match &font.cid_to_gid_map {
            Some(map) if !map.is_empty() => CidToGid::Map(map.clone()),
            _ => CidToGid::Identity,
        })
    } else {
        Mapping::Codes(true_type_codes(font, &ttf).map_err(|error| error.to_string())?)
    };
    Ok(Outlines { renderer: Arc::new(Mutex::new(renderer)), mapping })
}

/// `recoverGlyphName`: a glyph name the glyph list knows by the name it gives its code point.
fn recover_glyph_name(name: &str) -> String {
    if data::glyph_unicode(name).is_some() {
        return name.to_owned();
    }
    data::get_unicode_for_glyph(name, &data::glyphlist::GLYPHS_UNICODE).and_then(data::glyph_name_for_unicode).map_or_else(|| name.to_owned(), str::to_owned)
}

/// The character code to glyph id table of a simple TrueType font (`checkAndRepair`).
fn set_code(codes: &mut HashMap<u32, u16>, code: i64, glyph: i64) {
    if let (Ok(code), Ok(glyph)) = (u32::try_from(code), u16::try_from(glyph)) {
        codes.insert(code, glyph);
    }
}

/// The codes of a simple TrueType font with an encoding: the glyph name of each code (the differences, the base
/// encoding, the standard encoding) through the Unicode (platform 3) or Mac Roman (platform 1) `cmap`.
fn codes_through_encoding(font: &Font, cmap: &CmapTable, base_encoding: Option<&'static [&'static str; 256]>, codes: &mut HashMap<u32, u16>) {
    let mut by_char: HashMap<i64, i64> = HashMap::new();
    for mapping in &cmap.mappings {
        by_char.entry(mapping.char_code).or_insert(mapping.glyph_id);
    }
    for code in 0..256_i64 {
        let glyph_name = match font.differences.get(code) {
            Some(name) if !name.is_empty() => name,
            _ => match base_encoding {
                Some(base) if !base[code as usize].is_empty() => base[code as usize],
                _ => STANDARD_ENCODING[code as usize],
            },
        };
        if glyph_name.is_empty() {
            continue;
        }
        let standard = recover_glyph_name(glyph_name);
        let mut wanted: Option<i64> = if cmap.platform_id == 3 {
            data::glyph_unicode(&standard).map(i64::from)
        } else {
            Some(MAC_ROMAN_ENCODING.iter().position(|name| *name == standard).map_or(-1, |at| at as i64))
        };
        if wanted.is_none()
            && font.has_included_to_unicode_map
            && !font.to_unicode.is_identity()
            && let Some(UniValue::Str(text)) = font.to_unicode.get(code as u32)
            && let Some(first) = String::from_utf16_lossy(&text).chars().next()
        {
            wanted = Some(i64::from(u32::from(first)));
        }
        if let Some(glyph) = wanted.and_then(|wanted| by_char.get(&wanted)) {
            set_code(codes, code, *glyph);
        }
    }
}

/// The codes the `post` glyph names give: the names of the differences and the base encoding, for the codes without a
/// glyph yet (all of them when `force`).
fn add_post_table_codes(
    codes: &mut HashMap<u32, u16>,
    font: &Font,
    names: &[Option<String>],
    info: &GlyphInfo,
    base_encoding: Option<&'static [&'static str; 256]>,
    force: bool,
) {
    for code in 0..256_i64 {
        if !force && codes.contains_key(&(code as u32)) {
            continue;
        }
        let glyph_name = match font.differences.get(code) {
            Some(name) if !name.is_empty() => name,
            _ => base_encoding.map_or("", |base| base[code as usize]),
        };
        if glyph_name.is_empty() {
            continue;
        }
        if let Some(glyph) = names.iter().position(|name| name.as_deref() == Some(glyph_name)).filter(|glyph| *glyph > 0 && info.has_glyph(*glyph as i64)) {
            set_code(codes, code, glyph as i64);
        }
    }
}

fn true_type_codes(font: &Font, ttf: &SfntFile) -> Result<HashMap<u32, u16>> {
    let info = ttf.glyph_info(None)?;
    let cmap = ttf.read_cmap_table(font.is_symbolic_font, font.has_encoding)?;
    let (platform, encoding) = (cmap.platform_id, cmap.encoding_id);
    let mut codes: HashMap<u32, u16> = HashMap::new();
    let mut base_encoding: Option<&'static [&'static str; 256]> = None;
    if font.has_encoding && matches!(font.base_encoding_name.as_deref(), Some("MacRomanEncoding" | "WinAnsiEncoding")) {
        base_encoding = font.base_encoding_name.as_deref().and_then(get_encoding);
    }
    let mut force_post_table = false;
    if font.has_encoding && !font.is_symbolic_font && ((platform == 3 && encoding == 1) || (platform == 1 && encoding == 0)) {
        codes_through_encoding(font, &cmap, base_encoding, &mut codes);
    } else if platform == 0 {
        for mapping in &cmap.mappings {
            set_code(&mut codes, mapping.char_code, mapping.glyph_id);
        }
        force_post_table = true;
    } else if platform == 3 && encoding == 0 {
        for mapping in &cmap.mappings {
            let mut code = mapping.char_code;
            if (0xf000..=0xf0ff).contains(&code) {
                code &= 0xff;
            }
            set_code(&mut codes, code, mapping.glyph_id);
        }
    } else {
        for mapping in &cmap.mappings {
            set_code(&mut codes, mapping.char_code, mapping.glyph_id);
        }
    }
    let post_names = ttf.read_post_script_table(info.num_glyphs).filter(|post| post.valid).and_then(|post| post.glyph_names);
    if let Some(names) = post_names
        && (base_encoding.is_some() || font.differences.size() > 0)
    {
        add_post_table_codes(&mut codes, font, &names, &info, base_encoding, force_post_table);
    }
    Ok(codes)
}

/// A `cmap` (code point to glyph id) the renderer finds the parts of a `seac` glyph through.
fn unicode_ranges(by_unicode: &HashMap<u32, u16>) -> Vec<CmapRange> {
    let mut entries: Vec<(u32, u16)> = by_unicode.iter().map(|(u, g)| (*u, *g)).collect();
    entries.sort_unstable();
    let mut ranges: Vec<CmapRange> = entries
        .into_iter()
        .map(|(unicode, glyph)| CmapRange { start: unicode, end: unicode, id_delta: i64::from(glyph) - i64::from(unicode), ids: None })
        .collect();
    if ranges.is_empty() {
        ranges.push(CmapRange { start: 0, end: 0, id_delta: 0, ids: None });
    }
    ranges
}

/// The code point of each named glyph of a charset: the first glyph of a name wins.
fn unicode_table(names: &[Option<String>], dingbats: bool) -> HashMap<u32, u16> {
    let mut table = HashMap::new();
    for (glyph, name) in names.iter().enumerate() {
        let Some(name) = name else { continue };
        let unicode = if dingbats { data::dingbats_glyph_unicode(name).or_else(|| data::glyph_unicode(name)) } else { data::glyph_unicode(name) };
        if let (Some(unicode), Ok(glyph)) = (unicode, u16::try_from(glyph)) {
            table.entry(unicode).or_insert(glyph);
        }
    }
    table
}

/// `type1FontGlyphMapping`: the glyph of each code of a simple Type 1 or CFF font, by the glyph names of its encoding.
fn type1_codes(font: &Font, names: &[Option<String>]) -> HashMap<u32, u16> {
    let mut first: HashMap<&str, u16> = HashMap::new();
    for (glyph, name) in names.iter().enumerate() {
        if let (Some(name), Ok(glyph)) = (name, u16::try_from(glyph)) {
            first.entry(name.as_str()).or_insert(glyph);
        }
    }
    let mut codes = HashMap::new();
    let by_encoding = |codes: &mut HashMap<u32, u16>, encoding: &[&str]| {
        for (code, name) in encoding.iter().enumerate() {
            codes.insert(code as u32, first.get(name).copied().unwrap_or(0));
        }
    };
    if font.is_internal_font {
        by_encoding(&mut codes, font.default_encoding.as_slice());
    } else if let Some(encoding) = font.base_encoding_name.as_deref().and_then(get_encoding) {
        by_encoding(&mut codes, encoding.as_slice());
    } else if font.is_symbolic_font {
        if let Some(built_in) = &font.built_in_encoding {
            for (code, name) in built_in {
                codes.insert(*code, first.get(name.as_str()).copied().unwrap_or(0));
            }
        }
    } else {
        by_encoding(&mut codes, STANDARD_ENCODING.as_slice());
    }
    for (code, name) in font.differences.iter() {
        let mut glyph = first.get(name).copied();
        if glyph.is_none() {
            let standard = recover_glyph_name(name);
            if standard != name {
                glyph = first.get(standard.as_str()).copied();
            }
        }
        if code >= 0.0 && code.fract() == 0.0 && code < f64::from(u32::MAX) {
            codes.insert(code as u32, glyph.unwrap_or(0));
        }
    }
    codes
}

fn cff_outlines(font: &Font, program: &[u8]) -> std::result::Result<Outlines, String> {
    let mut properties = CffProperties::default();
    let cff = read_cff_font(program, &mut properties).map_err(|error| error.to_string())?;
    let outlines = parse_cff(program, true).map_err(|error| error.to_string())?;
    let names: Vec<Option<String>> = cff
        .charset
        .charset
        .iter()
        .map(|entry| match entry {
            CharsetEntry::Name(name) => name.clone(),
            CharsetEntry::Cid(_) => None,
        })
        .collect();
    let renderer = FontRenderer::from_type2(outlines, unicode_ranges(&unicode_table(&names, false)), usable_matrix(font.font_matrix));
    let mapping = if font.composite {
        if cff.is_cid_font {
            let mut charset = HashMap::new();
            for (glyph, entry) in cff.charset.charset.iter().enumerate() {
                if let (CharsetEntry::Cid(cid), Ok(glyph)) = (entry, u16::try_from(glyph)) {
                    charset.entry(*cid).or_insert(glyph);
                }
            }
            Mapping::Cid(CidToGid::Charset(charset))
        } else {
            Mapping::Cid(CidToGid::Identity)
        }
    } else {
        Mapping::Codes(type1_codes(font, &names))
    };
    Ok(Outlines { renderer: Arc::new(Mutex::new(renderer)), mapping })
}

fn type1_outlines(font: &Font, program: &[u8]) -> std::result::Result<Outlines, String> {
    let parsed = Type1Font::parse(program, Type1Options { length1: None, composite: font.composite }).map_err(|error| error.to_string())?;
    let names: Vec<Option<String>> = parsed.charset().into_iter().map(|name| Some(name.to_owned())).collect();
    let renderer = FontRenderer::from_type2(parsed.to_type2(), unicode_ranges(&unicode_table(&names, false)), usable_matrix(font.font_matrix));
    let mapping = if font.composite {
        let charset = (0..names.len().saturating_sub(1)).filter_map(|cid| Some((u32::try_from(cid).ok()?, u16::try_from(cid + 1).ok()?))).collect();
        Mapping::Cid(CidToGid::Charset(charset))
    } else {
        Mapping::Codes(type1_codes(font, &names))
    };
    Ok(Outlines { renderer: Arc::new(Mutex::new(renderer)), mapping })
}

// ---- the substitute faces -------------------------------------------------------------------------------------------

/// A bundled face with the table of the glyph each code point has in it.
struct SubstituteFace {
    renderer: Arc<Mutex<FontRenderer>>,
    by_unicode: Arc<HashMap<u32, u16>>,
}

fn embedded_file(file: &str) -> std::io::Result<Vec<u8>> {
    let bytes: &'static [u8] = match file {
        "LiberationSans-Regular.ttf" => {
            include_bytes!("../assets/standard_fonts/LiberationSans-Regular.ttf")
        }
        "LiberationSans-Bold.ttf" => {
            include_bytes!("../assets/standard_fonts/LiberationSans-Bold.ttf")
        }
        "LiberationSans-Italic.ttf" => {
            include_bytes!("../assets/standard_fonts/LiberationSans-Italic.ttf")
        }
        "LiberationSans-BoldItalic.ttf" => {
            include_bytes!("../assets/standard_fonts/LiberationSans-BoldItalic.ttf")
        }
        "FoxitFixed.pfb" => include_bytes!("../assets/standard_fonts/FoxitFixed.pfb"),
        "FoxitFixedBold.pfb" => include_bytes!("../assets/standard_fonts/FoxitFixedBold.pfb"),
        "FoxitFixedBoldItalic.pfb" => {
            include_bytes!("../assets/standard_fonts/FoxitFixedBoldItalic.pfb")
        }
        "FoxitFixedItalic.pfb" => include_bytes!("../assets/standard_fonts/FoxitFixedItalic.pfb"),
        "FoxitSerif.pfb" => include_bytes!("../assets/standard_fonts/FoxitSerif.pfb"),
        "FoxitSerifBold.pfb" => include_bytes!("../assets/standard_fonts/FoxitSerifBold.pfb"),
        "FoxitSerifBoldItalic.pfb" => {
            include_bytes!("../assets/standard_fonts/FoxitSerifBoldItalic.pfb")
        }
        "FoxitSerifItalic.pfb" => include_bytes!("../assets/standard_fonts/FoxitSerifItalic.pfb"),
        "FoxitSymbol.pfb" => include_bytes!("../assets/standard_fonts/FoxitSymbol.pfb"),
        "FoxitDingbats.pfb" => include_bytes!("../assets/standard_fonts/FoxitDingbats.pfb"),
        _ => {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no such bundled font"));
        }
    };
    Ok(bytes.to_vec())
}

type FaceCache = Mutex<HashMap<&'static str, Option<Arc<SubstituteFace>>>>;

fn substitute_face(standard: &'static str) -> Option<Arc<SubstituteFace>> {
    static FACES: OnceLock<FaceCache> = OnceLock::new();
    static FILES: OnceLock<StandardFonts> = OnceLock::new();
    let faces = FACES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(found) = lock(faces).get(standard) {
        return found.clone();
    }
    let files = FILES.get_or_init(|| StandardFonts::new(Box::new(embedded_file)));
    let made = files.fetch(standard).and_then(|bytes| match make_face(standard, &bytes) {
        Ok(face) => Some(Arc::new(face)),
        Err(message) => {
            tracing::warn!("the substitute face of {standard} cannot be read: {message}");
            None
        }
    });
    lock(faces).insert(standard, made.clone());
    made
}

fn make_face(standard: &str, bytes: &[u8]) -> std::result::Result<SubstituteFace, String> {
    if bytes.starts_with(&[0, 1, 0, 0]) {
        let ttf = SfntFile::parse(bytes, standard).map_err(|error| error.to_string())?;
        let table = |tag: &str| ttf.table_data(tag).ok_or_else(|| format!("the {tag} table is missing"));
        let (glyf, loca, head) = (table("glyf")?, table("loca")?, table("head")?);
        let renderer =
            FontRenderer::from_glyf(glyf, loca, be16(head, 50).unwrap_or(0) != 0, be16(head, 18).unwrap_or(0), None).map_err(|error| error.to_string())?;
        let cmap = ttf.read_cmap_table(false, true).map_err(|error| error.to_string())?;
        let mut by_unicode = HashMap::new();
        for mapping in &cmap.mappings {
            if let (Ok(code), Ok(glyph)) = (u32::try_from(mapping.char_code), u16::try_from(mapping.glyph_id)) {
                by_unicode.entry(code).or_insert(glyph);
            }
        }
        return Ok(SubstituteFace { renderer: Arc::new(Mutex::new(renderer)), by_unicode: Arc::new(by_unicode) });
    }
    let mut properties = CffProperties::default();
    let cff = read_cff_font(bytes, &mut properties).map_err(|error| error.to_string())?;
    let names: Vec<Option<String>> = cff
        .charset
        .charset
        .iter()
        .map(|entry| match entry {
            CharsetEntry::Name(name) => name.clone(),
            CharsetEntry::Cid(_) => None,
        })
        .collect();
    let by_unicode = unicode_table(&names, standard == "ZapfDingbats");
    let outlines = parse_cff(bytes, true).map_err(|error| error.to_string())?;
    let matrix = usable_matrix(properties.font_matrix.as_deref().and_then(|matrix| <[f64; 6]>::try_from(matrix).ok()));
    Ok(SubstituteFace {
        renderer: Arc::new(Mutex::new(FontRenderer::from_type2(outlines, unicode_ranges(&by_unicode), matrix))),
        by_unicode: Arc::new(by_unicode),
    })
}

/// The standard font a font without a program is drawn as: its own name when it is one of the standard 14 (or a name
/// pdf.js maps to one), else what its flags and name say (fixed pitch, serif, bold, italic).
fn substitute_name(font: &Font) -> &'static str {
    let mut name = font.name.as_str();
    if name.len() > 7 && name.as_bytes()[6] == b'+' && name.as_bytes()[..6].iter().all(u8::is_ascii_uppercase) {
        name = &name[7..];
    }
    if let Some(standard) = standard_font_name(name) {
        return standard;
    }
    let normalized = normalize_font_name(name);
    if let Some(mapped) = data::lookup(&NON_STD_FONT_MAP, &normalized).and_then(|mapped| data::lookup(&STD_FONT_MAP, mapped)).and_then(standard_font_name) {
        return mapped;
    }
    let lower = name.to_lowercase();
    let bold = lower.contains("bold") || font.flags & font_flags::FORCE_BOLD as i32 != 0;
    let italic = lower.contains("italic") || lower.contains("oblique") || font.flags & font_flags::ITALIC as i32 != 0 || font.italic_angle != 0.0;
    let styles = if font.is_monospace {
        ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"]
    } else if font.is_serif_font {
        ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"]
    } else {
        ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"]
    };
    // index: 0 regular, 1 bold, 2 italic, 3 bold italic
    let index = match (bold, italic) {
        (false, false) => 0,
        (true, false) => 1,
        (false, true) => 2,
        (true, true) => 3,
    };
    styles[index]
}

fn substitute_outlines(font: &Font) -> std::result::Result<Outlines, String> {
    let standard = substitute_name(font);
    let face = substitute_face(standard).ok_or_else(|| format!("the substitute face {standard} is not available"))?;
    Ok(Outlines { renderer: Arc::clone(&face.renderer), mapping: Mapping::Unicode(Arc::clone(&face.by_unicode)) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::font::Properties;
    use crate::fonts::to_unicode::{ToUnicode, ToUnicodeMap};

    fn font(has_encoding: bool, is_symbolic: bool, base_encoding: Option<&str>, differences: &[(u32, &str)]) -> Font {
        let properties = Properties { to_unicode: Some(ToUnicode::Map(ToUnicodeMap::new())), ..Properties::default() };
        let mut font = Font::new("Test", None, properties).unwrap();
        font.has_encoding = has_encoding;
        font.is_symbolic_font = is_symbolic;
        font.base_encoding_name = base_encoding.map(str::to_owned);
        for (code, name) in differences {
            font.differences.set(f64::from(*code), (*name).to_owned());
        }
        font
    }

    fn u16s(values: &[u16]) -> Vec<u8> {
        values.iter().flat_map(|value| value.to_be_bytes()).collect()
    }

    /// A `cmap` table with one format 6 subtable: `glyphs[i]` for the code `first + i`.
    fn cmap_format6(platform: u16, encoding: u16, first: u16, glyphs: &[u16]) -> Vec<u8> {
        let mut table = u16s(&[0, 1, platform, encoding]);
        table.extend_from_slice(&12u32.to_be_bytes());
        table.extend(u16s(&[6, 10 + 2 * glyphs.len() as u16, 0, first, glyphs.len() as u16]));
        table.extend(u16s(glyphs));
        table
    }

    /// A format 2 `post` table of three glyphs: `.notdef`, then the custom names `foo` and `bar`.
    fn post_foo_bar() -> Vec<u8> {
        let mut table = 0x0002_0000u32.to_be_bytes().to_vec();
        table.extend([0u8; 28]);
        table.extend(u16s(&[3, 0, 258, 259]));
        table.extend([3, b'f', b'o', b'o', 3, b'b', b'a', b'r']);
        table
    }

    /// An sfnt whose outlines are `CFF ` (so `glyph_info` reads no `loca` and every glyph counts as present) and
    /// whose `maxp` says three glyphs.
    fn sfnt(cmap: Vec<u8>, post: Option<Vec<u8>>) -> SfntFile {
        let mut tables: Vec<(&[u8; 4], Vec<u8>)> = vec![
            (b"head", vec![0; 54]),
            (b"hhea", vec![0; 36]),
            (b"hmtx", vec![0; 12]),
            (b"maxp", vec![0, 1, 0, 0, 0, 3]),
            (b"CFF ", vec![0; 4]),
            (b"cmap", cmap),
        ];
        if let Some(post) = post {
            tables.push((b"post", post));
        }
        let mut file = vec![0, 1, 0, 0];
        file.extend(u16s(&[tables.len() as u16, 0, 0, 0]));
        let mut offset = 12 + 16 * tables.len() as u32;
        for (tag, data) in &tables {
            file.extend_from_slice(*tag);
            file.extend_from_slice(&[0; 4]);
            file.extend_from_slice(&offset.to_be_bytes());
            file.extend_from_slice(&(data.len() as u32).to_be_bytes());
            offset += data.len() as u32;
        }
        for (_, data) in &tables {
            file.extend_from_slice(data);
        }
        SfntFile::parse(&file, "Test").unwrap()
    }

    fn sorted(codes: HashMap<u32, u16>) -> Vec<(u32, u16)> {
        let mut codes: Vec<(u32, u16)> = codes.into_iter().collect();
        codes.sort_unstable();
        codes
    }

    #[test]
    fn a_windows_unicode_cmap_is_reached_through_the_glyph_names_of_the_base_encoding() {
        let ttf = sfnt(cmap_format6(3, 1, 0x41, &[1, 2]), None);
        let font = font(true, false, Some("WinAnsiEncoding"), &[]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1), (0x42, 2)]);
    }

    #[test]
    fn a_difference_sends_its_code_to_the_glyph_of_the_named_character() {
        let ttf = sfnt(cmap_format6(3, 1, 0x41, &[1, 2]), None);
        let font = font(true, false, Some("WinAnsiEncoding"), &[(0x61, "B")]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1), (0x42, 2), (0x61, 2)]);
    }

    #[test]
    fn a_unicode_platform_cmap_maps_its_codes_as_they_are() {
        let ttf = sfnt(cmap_format6(0, 3, 0x41, &[1, 2]), None);
        let font = font(true, false, Some("WinAnsiEncoding"), &[]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1), (0x42, 2)]);
    }

    #[test]
    fn a_symbol_cmap_folds_the_private_use_codes_onto_one_byte() {
        let ttf = sfnt(cmap_format6(3, 0, 0xF041, &[1]), None);
        let font = font(false, true, None, &[]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1)]);
    }

    #[test]
    fn any_other_cmap_without_an_encoding_maps_its_codes_as_they_are() {
        let ttf = sfnt(cmap_format6(1, 0, 0x41, &[1]), None);
        let font = font(false, false, None, &[]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1)]);
    }

    #[test]
    fn post_names_fill_the_codes_the_cmap_left_empty() {
        let ttf = sfnt(cmap_format6(1, 0, 0x41, &[1]), Some(post_foo_bar()));
        let font = font(false, false, None, &[(0x62, "bar")]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1), (0x62, 2)]);
    }

    #[test]
    fn post_names_do_not_replace_a_code_the_cmap_gave() {
        let ttf = sfnt(cmap_format6(1, 0, 0x41, &[1]), Some(post_foo_bar()));
        let font = font(false, false, None, &[(0x41, "bar")]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 1)]);
    }

    #[test]
    fn post_names_replace_the_codes_of_a_unicode_platform_cmap() {
        let ttf = sfnt(cmap_format6(0, 3, 0x41, &[1]), Some(post_foo_bar()));
        let font = font(false, false, None, &[(0x41, "bar")]);
        assert_eq!(sorted(true_type_codes(&font, &ttf).unwrap()), vec![(0x41, 2)]);
    }
}
