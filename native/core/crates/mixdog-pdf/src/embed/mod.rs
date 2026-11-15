//! Font embedding for the PDF writer: what pdf-lib 1.17.1 with `@pdf-lib/fontkit` 1.1.1 gives the office writers
//! (`src/runtime/office/pdf/pdf-fonts.mjs`, `pdf-writer.mjs`, `pdf-forms.mjs`).
//!
//! A [`Font`] is either one of the standard 14 ([`standard`]: WinAnsi, the AFM widths and kerning) or a TrueType /
//! OpenType face embedded as a Type0 font with a CIDFontType2 (glyf, `subset_glyf`) or CIDFontType0 (CFF,
//! `subset_cff`) descendant: Identity-H, `CIDToGIDMap Identity`, a `W` array, a ToUnicode CMap (`tounicode`), a font
//! descriptor and the subset program. The subset is made when the font is written ([`Font::embed_into`]); the glyphs
//! it holds are the ones text was encoded with, in the order they were met.
//!
//! The choice of face for a document is [`embed_document_font`] and [`embed_bold_font`] (pdf-fonts.mjs): the
//! standard font when it covers the text, else the explicit face, `MIXDOG_OCR_FONT`, or the first system face that
//! does, and the typographic stand-ins ([`Font::with_stand_ins`]) for the characters a face often lacks.
//!
//! Differences from pdf-lib that are on purpose: the faces tried and rejected while choosing are not left in the file as
//! unused font objects (a Rust document registers the chosen font only); the text is laid out with HarfBuzz's
//! shaping ([`mixdog_fonts::shape`], the engine of the canvas measurement) where fontkit has its own shaper, as one run
//! of the first script of the string as fontkit does, and a glyph's width is its advance in the `hmtx` table in both.
//!
//! Not ported yet (fontkit reads them, so pdf-fonts.mjs is not deletable before they are): WOFF, WOFF2 and dfont files.

pub mod standard;
mod subset_cff;
mod subset_glyf;
mod tounicode;

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_fonts::face::Face;
use mixdog_fonts::shape;
use mixdog_fsio::ReadProof;

use crate::write::flate_stream;
use crate::write::store::ObjectStore;
use crate::{Dict, Obj, Ref};

pub use standard::{StandardFont, StandardFontName};
use tounicode::GlyphUnicode;

/// A refusal of the embedder, with the text pdf-lib, fontkit or `pdf-fonts.mjs` gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedError(String);

impl EmbedError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for EmbedError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.0)
    }
}

impl std::error::Error for EmbedError {}

pub(crate) fn be_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*data.get(at)?, *data.get(at + 1)?]))
}

pub(crate) fn be_i16(data: &[u8], at: usize) -> Option<i16> {
    be_u16(data, at).map(|value| value as i16)
}

pub(crate) fn be_u32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *data.get(at)?,
        *data.get(at + 1)?,
        *data.get(at + 2)?,
        *data.get(at + 3)?,
    ]))
}

/// The table directory of an sfnt file (`true`, `OTTO` or version 1.0): where each table is.
pub(crate) struct Sfnt<'a> {
    data: &'a [u8],
    tables: Vec<([u8; 4], usize, usize)>,
}

impl<'a> Sfnt<'a> {
    pub(crate) fn parse(data: &'a [u8]) -> Self {
        let count = usize::from(be_u16(data, 4).unwrap_or(0));
        let mut tables = Vec::with_capacity(count);
        for index in 0..count {
            let at = 12 + index * 16;
            let (Some(tag), Some(offset), Some(length)) = (
                data.get(at..at + 4),
                be_u32(data, at + 8),
                be_u32(data, at + 12),
            ) else {
                break;
            };
            tables.push((
                [tag[0], tag[1], tag[2], tag[3]],
                offset as usize,
                length as usize,
            ));
        }
        Self { data, tables }
    }

    /// The table `tag`; `None` when the file has none or it runs past the end of the file.
    pub(crate) fn table(&self, tag: &[u8; 4]) -> Option<&'a [u8]> {
        let (_, offset, length) = self.tables.iter().find(|(name, _, _)| name == tag)?;
        self.data.get(*offset..offset.checked_add(*length)?)
    }
}

/// pdf-lib's `SimpleRNG` as `PDFContext.addRandomSuffix` uses it: the suffix of a font's name (4 digits) and of a page's
/// font resource key (`PDFDict.uniqueKey`, 10 digits) is the next number of one counter that starts at 1 for each
/// document, so the names are the same from run to run.
#[derive(Debug, Clone)]
pub struct SuffixRng {
    seed: u64,
}

impl Default for SuffixRng {
    fn default() -> Self {
        Self { seed: 1 }
    }
}

impl SuffixRng {
    fn next_fraction(&mut self) -> f64 {
        let value = (self.seed as f64).sin() * 10000.0;
        self.seed += 1;
        value - value.floor()
    }

    /// `addRandomSuffix(prefix, digits)`: `prefix-N` with N below `10^digits`.
    pub fn name(&mut self, prefix: &str, digits: i32) -> String {
        format!(
            "{prefix}-{}",
            (self.next_fraction() * 10f64.powi(digits)).floor() as u64
        )
    }
}

// ---- the embedded face ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Shaped {
    glyph: u16,
}

#[derive(Default)]
struct State {
    /// The characters each glyph was first met for (fontkit caches a glyph with the code points of its first layout).
    first_code_points: HashMap<u16, Vec<u32>>,
    /// The glyphs encoded so far, in order: the original id of the glyph with subset id `position + 1` (`.notdef` is 0).
    encoded: Vec<u16>,
    subset_ids: HashMap<u16, u16>,
    layouts: HashMap<String, Vec<Shaped>>,
}

/// The cache of laid-out strings is dropped whole beyond this size.
const LAYOUT_CACHE_LIMIT: usize = 8192;

/// A TrueType or OpenType face being embedded as a subset.
pub struct EmbeddedFace {
    data: Arc<[u8]>,
    face: Face,
    postscript_name: String,
    scale: f64,
    cff: bool,
    ascent: i16,
    descent: i16,
    cap_height: Option<i16>,
    x_height: Option<i16>,
    bbox: [i16; 4],
    italic_angle: f64,
    fixed_pitch: bool,
    family_class: i16,
    italic: bool,
    /// The advance of each glyph with a metric in `hmtx`; the later glyphs have the last one.
    advances: Vec<u16>,
    state: Mutex<State>,
}

impl fmt::Debug for EmbeddedFace {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("EmbeddedFace")
            .field("postscript_name", &self.postscript_name)
            .field("cff", &self.cff)
            .finish_non_exhaustive()
    }
}

impl EmbeddedFace {
    /// Reads a font file. A collection (`.ttc`) and a file that is not a font are refused with the text pdf-lib gives.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, EmbedError> {
        match bytes.get(..4) {
            Some(b"true" | b"OTTO" | [0, 1, 0, 0]) => {}
            // fontkit returns a collection object, which has no subset to make
            Some(b"ttcf") => {
                return Err(EmbedError::new("_this.font.createSubset is not a function"));
            }
            Some(b"wOFF" | b"wOF2") => {
                return Err(EmbedError::new(
                    "WOFF and WOFF2 fonts are not supported: embed the TrueType or OpenType file",
                ));
            }
            _ => return Err(EmbedError::new("Unknown font format")),
        }
        let data: Arc<[u8]> = Arc::from(bytes);
        let sfnt = Sfnt::parse(&data);
        let head = sfnt
            .table(b"head")
            .filter(|head| head.len() >= 54)
            .ok_or_else(|| {
                EmbedError::new("Cannot read properties of undefined (reading 'unitsPerEm')")
            })?;
        let face =
            Face::new(Arc::clone(&data), 0).map_err(|error| EmbedError::new(error.to_string()))?;
        let cff = sfnt.table(b"CFF ").is_some();
        if !cff && sfnt.table(b"glyf").is_none_or(<[u8]>::is_empty) {
            return Err(EmbedError::new(
                "The font has no glyph outlines (a glyf or CFF table)",
            ));
        }
        let units_per_em = be_u16(head, 18)
            .filter(|units| *units != 0)
            .ok_or_else(|| EmbedError::new("The font has no units per em"))?;
        let hhea = sfnt.table(b"hhea").unwrap_or(&[]);
        let os2 = sfnt.table(b"OS/2");
        let post = sfnt.table(b"post");
        let postscript_name = if face.postscript_name.is_empty() {
            "Font".to_owned()
        } else {
            face.postscript_name.clone()
        };
        Ok(Self {
            scale: 1000.0 / f64::from(units_per_em),
            cff,
            ascent: be_i16(hhea, 4).unwrap_or(0),
            descent: be_i16(hhea, 6).unwrap_or(0),
            // the OS/2 table has them from version 2
            cap_height: os2
                .filter(|table| be_u16(table, 0).unwrap_or(0) >= 2)
                .and_then(|table| be_i16(table, 88)),
            x_height: os2
                .filter(|table| be_u16(table, 0).unwrap_or(0) >= 2)
                .and_then(|table| be_i16(table, 86)),
            bbox: [
                be_i16(head, 36).unwrap_or(0),
                be_i16(head, 38).unwrap_or(0),
                be_i16(head, 40).unwrap_or(0),
                be_i16(head, 42).unwrap_or(0),
            ],
            italic_angle: post
                .and_then(|table| be_u32(table, 4))
                .map_or(0.0, |angle| f64::from(angle as i32) / 65536.0),
            fixed_pitch: post
                .and_then(|table| be_u32(table, 12))
                .is_some_and(|fixed| fixed != 0),
            family_class: os2.and_then(|table| be_i16(table, 30)).unwrap_or(0),
            italic: be_u16(head, 44).is_some_and(|style| style & 2 != 0),
            advances: {
                let hmtx = sfnt.table(b"hmtx").unwrap_or(&[]);
                (0..usize::from(be_u16(hhea, 34).unwrap_or(0)))
                    .map(|index| be_u16(hmtx, index * 4).unwrap_or(0))
                    .collect()
            },
            postscript_name,
            face,
            data,
            state: Mutex::new(State::default()),
        })
    }

    /// The PostScript name of the face (`Font` when it has none).
    pub fn name(&self) -> &str {
        &self.postscript_name
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// True when the face's cmap maps `character` to a glyph.
    pub fn has_glyph(&self, character: char) -> bool {
        self.face.has_glyph(character)
    }

    fn advance(&self, glyph: u16) -> f64 {
        let index = usize::from(glyph).min(self.advances.len().saturating_sub(1));
        f64::from(self.advances.get(index).copied().unwrap_or(0))
    }

    /// The glyphs of `text`, laid out by the shaper; the characters each glyph stands for are remembered the first
    /// time the glyph is met.
    fn layout(&self, text: &str) -> Vec<Shaped> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut state = self.lock();
        if let Some(found) = state.layouts.get(text) {
            return found.clone();
        }
        // fontkit shapes the whole string as one run: the script and with it the direction are the first script that is
        // not Common or Inherited, and a right-to-left string comes out in visual order.
        let rtl = shape::runs(text).first().is_some_and(|run| run.rtl);
        let shaped = match shape::hb_face(&self.face, &[]) {
            Some(face) => shape::shape_run(&face, text, rtl, 0),
            None => Vec::new(),
        };
        let mut clusters: Vec<usize> = shaped.iter().map(|glyph| glyph.cluster).collect();
        clusters.sort_unstable();
        clusters.dedup();
        let mut glyphs = Vec::with_capacity(shaped.len());
        for glyph in &shaped {
            let end = clusters
                .iter()
                .find(|cluster| **cluster > glyph.cluster)
                .copied()
                .unwrap_or(text.len());
            let code_points: Vec<u32> = text
                .get(glyph.cluster..end)
                .unwrap_or("")
                .chars()
                .map(u32::from)
                .collect();
            state
                .first_code_points
                .entry(glyph.glyph_id)
                .or_insert(code_points);
            glyphs.push(Shaped {
                glyph: glyph.glyph_id,
            });
        }
        if state.layouts.len() >= LAYOUT_CACHE_LIMIT {
            state.layouts.clear();
        }
        state.layouts.insert(text.to_owned(), glyphs.clone());
        glyphs
    }

    /// `encodeText`: two bytes of subset glyph id for each glyph (pdf-lib writes them as a hex string). The glyphs
    /// become part of the subset.
    pub fn encode_text(&self, text: &str) -> Vec<u8> {
        let glyphs = self.layout(text);
        let mut state = self.lock();
        let mut out = Vec::with_capacity(glyphs.len() * 2);
        for shaped in glyphs {
            let id = match state.subset_ids.get(&shaped.glyph) {
                Some(id) => *id,
                None if shaped.glyph == 0 => 0,
                None => {
                    state.encoded.push(shaped.glyph);
                    let id = state.encoded.len() as u16;
                    state.subset_ids.insert(shaped.glyph, id);
                    id
                }
            };
            out.extend_from_slice(&id.to_be_bytes());
        }
        out
    }

    /// `widthOfTextAtSize`: the `hmtx` advances of the laid-out glyphs, scaled to 1000 units to the em.
    pub fn width_of_text_at_size(&self, text: &str, size: f64) -> f64 {
        let total: f64 = self
            .layout(text)
            .iter()
            .map(|shaped| self.advance(shaped.glyph) * self.scale)
            .sum();
        total * (size / 1000.0)
    }

    fn extent(&self) -> (f64, f64) {
        let top = if self.ascent != 0 {
            f64::from(self.ascent)
        } else {
            f64::from(self.bbox[3])
        } * self.scale;
        let bottom = if self.descent != 0 {
            f64::from(self.descent)
        } else {
            f64::from(self.bbox[1])
        } * self.scale;
        (top, bottom)
    }

    /// `heightAtSize` (pdf-lib's quirk kept: without the descender the descent is subtracted unscaled).
    pub fn height_at_size(&self, size: f64, descender: bool) -> f64 {
        let (top, bottom) = self.extent();
        let mut height = top - bottom;
        if !descender {
            height -= f64::from(self.descent).abs();
        }
        (height / 1000.0) * size
    }

    /// `sizeAtHeight`.
    pub fn size_at_height(&self, height: f64) -> f64 {
        let (top, bottom) = self.extent();
        (1000.0 * height) / (top - bottom)
    }

    fn flags(&self) -> i64 {
        let mut flags = 0;
        if self.fixed_pitch {
            flags |= 1;
        }
        if (1..=7).contains(&self.family_class) {
            flags |= 1 << 1;
        }
        flags |= 1 << 2; // symbolic
        if self.family_class == 10 {
            flags |= 1 << 3;
        }
        if self.italic {
            flags |= 1 << 6;
        }
        flags
    }

    /// Writes the font into `store` the way `CustomFontEmbedder.embedIntoContext` does (the program, the descriptor, the
    /// CIDFont, the ToUnicode CMap, then the Type0 dictionary, assigned to `target` when given) and returns its reference.
    pub fn embed_into(
        &self,
        store: &mut ObjectStore,
        target: Option<Ref>,
        rng: &mut SuffixRng,
    ) -> Result<Ref, EmbedError> {
        let base_font = rng.name(&self.postscript_name, 4);
        let (encoded, first) = {
            let state = self.lock();
            (state.encoded.clone(), state.first_code_points.clone())
        };
        let mut glyphs: Vec<u16> = std::iter::once(0).chain(encoded.iter().copied()).collect();
        let sfnt = Sfnt::parse(&self.data);
        let program = if self.cff {
            subset_cff::subset(
                sfnt.table(b"CFF ")
                    .ok_or_else(|| EmbedError::new("The font has no CFF table"))?,
                &glyphs,
            )?
        } else {
            subset_glyf::subset(&sfnt, &mut glyphs)?
        };

        let mut program_dict = Dict::new();
        if self.cff {
            program_dict.set("Subtype", Obj::name("CIDFontType0C"));
        }
        let program_ref = store.register(flate_stream(program_dict, &program));

        let scale = self.scale;
        let mut descriptor = Dict::new();
        descriptor.set("Type", Obj::name("FontDescriptor"));
        descriptor.set("FontName", Obj::name(&base_font));
        descriptor.set("Flags", Obj::Num(self.flags() as f64));
        descriptor.set(
            "FontBBox",
            Obj::Array(Arc::new(
                self.bbox
                    .iter()
                    .map(|value| Obj::Num(f64::from(*value) * scale))
                    .collect(),
            )),
        );
        descriptor.set("ItalicAngle", Obj::Num(self.italic_angle));
        descriptor.set("Ascent", Obj::Num(f64::from(self.ascent) * scale));
        descriptor.set("Descent", Obj::Num(f64::from(self.descent) * scale));
        let cap_height = self
            .cap_height
            .filter(|height| *height != 0)
            .unwrap_or(self.ascent);
        descriptor.set("CapHeight", Obj::Num(f64::from(cap_height) * scale));
        descriptor.set(
            "XHeight",
            Obj::Num(f64::from(self.x_height.unwrap_or(0)) * scale),
        );
        descriptor.set("StemV", Obj::Num(0.0));
        descriptor.set(
            if self.cff { "FontFile3" } else { "FontFile2" },
            Obj::Ref(program_ref),
        );
        let descriptor_ref = store.register(Obj::Dict(Arc::new(descriptor)));

        let widths: Vec<Obj> = encoded
            .iter()
            .map(|glyph| Obj::Num(self.advance(*glyph) * scale))
            .collect();
        let mut w = Vec::new();
        if !widths.is_empty() {
            w.push(Obj::Num(1.0));
        }
        w.push(Obj::Array(Arc::new(widths)));
        let mut cid = Dict::new();
        cid.set("Type", Obj::name("Font"));
        cid.set(
            "Subtype",
            Obj::name(if self.cff {
                "CIDFontType0"
            } else {
                "CIDFontType2"
            }),
        );
        cid.set("CIDToGIDMap", Obj::name("Identity"));
        cid.set("BaseFont", Obj::name(&base_font));
        let mut system_info = Dict::new();
        system_info.set("Registry", Obj::string(b"Adobe"));
        system_info.set("Ordering", Obj::string(b"Identity"));
        system_info.set("Supplement", Obj::Num(0.0));
        cid.set("CIDSystemInfo", Obj::Dict(Arc::new(system_info)));
        cid.set("FontDescriptor", Obj::Ref(descriptor_ref));
        cid.set("W", Obj::Array(Arc::new(w)));
        let cid_ref = store.register(Obj::Dict(Arc::new(cid)));

        let unicode: Vec<GlyphUnicode> = encoded
            .iter()
            .enumerate()
            .map(|(position, glyph)| GlyphUnicode {
                glyph_id: (position + 1) as u16,
                code_points: first.get(glyph).cloned().unwrap_or_default(),
            })
            .collect();
        let cmap_ref = store.register(flate_stream(
            Dict::new(),
            tounicode::create_cmap(&unicode).as_bytes(),
        ));

        let mut font = Dict::new();
        font.set("Type", Obj::name("Font"));
        font.set("Subtype", Obj::name("Type0"));
        font.set("BaseFont", Obj::name(&base_font));
        font.set("Encoding", Obj::name("Identity-H"));
        font.set(
            "DescendantFonts",
            Obj::Array(Arc::new(vec![Obj::Ref(cid_ref)])),
        );
        font.set("ToUnicode", Obj::Ref(cmap_ref));
        let font = Obj::Dict(Arc::new(font));
        Ok(match target {
            Some(target) => {
                store.assign(target, font);
                target
            }
            None => store.register(font),
        })
    }
}

// ---- a font ---------------------------------------------------------------------------------------------------------------------------

/// Typographic characters a face often lacks, each with the characters that set it the way a typesetter would (the
/// writing guide asks for the minus sign on a negative figure, which Malgun Gothic and the standard fonts have none of).
const TYPOGRAPHIC_STAND_INS: [(char, &[char]); 7] = [
    ('\u{2212}', &['\u{2013}', '-']),
    ('\u{2010}', &['-']),
    ('\u{2011}', &['-']),
    ('\u{2007}', &[' ']),
    ('\u{2009}', &[' ']),
    ('\u{200A}', &[' ']),
    ('\u{202F}', &[' ']),
];

#[derive(Debug, Clone)]
enum Kind {
    Standard(StandardFont),
    Embedded(Arc<EmbeddedFace>),
}

/// A font of a document: a standard font or an embedded face, with the stand-in characters it applies when it encodes
/// or measures text.
#[derive(Debug, Clone)]
pub struct Font {
    kind: Kind,
    substitutes: BTreeMap<char, char>,
}

impl Font {
    pub fn standard(name: StandardFontName) -> Self {
        Self {
            kind: Kind::Standard(StandardFont::new(name)),
            substitutes: BTreeMap::new(),
        }
    }

    pub fn embedded(face: EmbeddedFace) -> Self {
        Self {
            kind: Kind::Embedded(Arc::new(face)),
            substitutes: BTreeMap::new(),
        }
    }

    /// The font's name: the PostScript name of the face.
    pub fn name(&self) -> &str {
        match &self.kind {
            Kind::Standard(font) => font.name(),
            Kind::Embedded(face) => face.name(),
        }
    }

    pub fn is_embedded(&self) -> bool {
        matches!(self.kind, Kind::Embedded(_))
    }

    /// True when `self` and `other` are the same font object (the writer's regular and bold are the same when a face has
    /// no bold companion).
    pub fn same_font(&self, other: &Font) -> bool {
        match (&self.kind, &other.kind) {
            (Kind::Standard(a), Kind::Standard(b)) => a.font_name() == b.font_name(),
            (Kind::Embedded(a), Kind::Embedded(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    fn substitute(&self, text: &str) -> String {
        if self.substitutes.is_empty() {
            return text.to_owned();
        }
        text.chars()
            .map(|character| {
                self.substitutes
                    .get(&character)
                    .copied()
                    .unwrap_or(character)
            })
            .collect()
    }

    /// `encodeText`: the bytes of the string pdf-lib writes as a hex string (one byte a character for a standard font,
    /// two bytes a glyph for an embedded face). A standard font refuses a character its encoding lacks.
    pub fn encode_text(&self, text: &str) -> Result<Vec<u8>, EmbedError> {
        let text = self.substitute(text);
        match &self.kind {
            Kind::Standard(font) => font.encode_text(&text),
            Kind::Embedded(face) => Ok(face.encode_text(&text)),
        }
    }

    /// `widthOfTextAtSize`.
    pub fn width_of_text_at_size(&self, text: &str, size: f64) -> Result<f64, EmbedError> {
        let text = self.substitute(text);
        match &self.kind {
            Kind::Standard(font) => font.width_of_text_at_size(&text, size),
            Kind::Embedded(face) => Ok(face.width_of_text_at_size(&text, size)),
        }
    }

    /// `heightAtSize`.
    pub fn height_at_size(&self, size: f64, descender: bool) -> f64 {
        match &self.kind {
            Kind::Standard(font) => font.height_at_size(size, descender),
            Kind::Embedded(face) => face.height_at_size(size, descender),
        }
    }

    /// `sizeAtHeight`.
    pub fn size_at_height(&self, height: f64) -> f64 {
        match &self.kind {
            Kind::Standard(font) => font.size_at_height(height),
            Kind::Embedded(face) => face.size_at_height(height),
        }
    }

    /// pdf-fonts.mjs `hasGlyph`: a face is asked for the character; a standard font encodes it (after the stand-ins).
    pub fn has_glyph(&self, character: char) -> bool {
        match &self.kind {
            Kind::Standard(font) => font.can_encode(
                self.substitutes
                    .get(&character)
                    .copied()
                    .unwrap_or(character),
            ),
            Kind::Embedded(face) => face.has_glyph(character),
        }
    }

    fn stand_in(&self, character: char) -> Option<char> {
        let (_, candidates) = TYPOGRAPHIC_STAND_INS
            .iter()
            .find(|(key, _)| *key == character)?;
        candidates
            .iter()
            .copied()
            .find(|candidate| self.has_glyph(*candidate))
    }

    /// pdf-fonts.mjs `uncoveredCharacters`: the characters of `text` with no glyph and no stand-in, in first-seen order.
    fn uncovered(&self, text: &str, limit: usize) -> Vec<char> {
        let mut missing = Vec::new();
        for character in text.chars() {
            if u32::from(character) <= 32 || missing.contains(&character) {
                continue;
            }
            if self.has_glyph(character) || self.stand_in(character).is_some() {
                continue;
            }
            missing.push(character);
            if missing.len() >= limit {
                break;
            }
        }
        missing
    }

    /// pdf-fonts.mjs `fontCovers`: every character of `text` has a glyph in the font, or a typographic stand-in it has.
    pub fn covers(&self, text: &str) -> bool {
        let mut seen: Vec<char> = Vec::new();
        for character in text.chars() {
            if u32::from(character) <= 32 || seen.contains(&character) {
                continue;
            }
            seen.push(character);
            if !self.has_glyph(character) && self.stand_in(character).is_none() {
                return false;
            }
        }
        true
    }

    /// pdf-fonts.mjs `withStandIns`: the same font with each typographic character it lacks (and has a stand-in for)
    /// replaced when text is encoded or measured. A face that has all of them is returned unchanged.
    pub fn with_stand_ins(&self) -> Font {
        let mut substitutes = BTreeMap::new();
        for (character, _) in TYPOGRAPHIC_STAND_INS {
            if self.has_glyph(character) {
                continue;
            }
            if let Some(replacement) = self.stand_in(character) {
                substitutes.insert(character, replacement);
            }
        }
        if substitutes.is_empty() {
            return self.clone();
        }
        Font {
            kind: self.kind.clone(),
            substitutes,
        }
    }

    /// Writes the font into `store` (what `embedIntoContext` does) and returns the reference of its dictionary,
    /// assigned to `target` when given.
    pub fn embed_into(
        &self,
        store: &mut ObjectStore,
        target: Option<Ref>,
        rng: &mut SuffixRng,
    ) -> Result<Ref, EmbedError> {
        match &self.kind {
            Kind::Standard(font) => {
                let dict = Obj::Dict(Arc::new(font.dictionary()));
                Ok(match target {
                    Some(target) => {
                        store.assign(target, dict);
                        target
                    }
                    None => store.register(dict),
                })
            }
            Kind::Embedded(face) => face.embed_into(store, target, rng),
        }
    }
}

// ---- choosing the font of a document ---------------------------------------------------------------------------------------

const PDF_FONT_HINT: &str = "pass fontPath pointing to a Unicode TrueType/OpenType font (Windows: C:\\Windows\\Fonts\\malgun.ttf) or set MIXDOG_OCR_FONT";

/// What the choice of a font reads from the machine: the `MIXDOG_OCR_FONT` override and the list of system faces.
#[derive(Debug, Clone, Default)]
pub struct FontEnv {
    pub ocr_font: Option<String>,
    pub system_fonts: Vec<String>,
}

impl FontEnv {
    /// The setting `MIXDOG_OCR_FONT` and the faces a machine of this platform is likely to have.
    pub fn host() -> Self {
        let mut system_fonts: Vec<&str> = Vec::new();
        if cfg!(windows) {
            system_fonts.extend([
                "C:\\Windows\\Fonts\\malgun.ttf",
                "C:\\Windows\\Fonts\\arialuni.ttf",
                "C:\\Windows\\Fonts\\segoeui.ttf",
            ]);
        }
        if cfg!(target_os = "macos") {
            system_fonts.extend([
                "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
                "/Library/Fonts/Arial Unicode.ttf",
                "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            ]);
        }
        system_fonts.extend([
            "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        ]);
        Self {
            ocr_font: std::env::var("MIXDOG_OCR_FONT").ok(),
            system_fonts: system_fonts.into_iter().map(str::to_owned).collect(),
        }
    }
}

/// `path.resolve`: relative to the working directory, `.` and `..` folded away.
fn resolve(path: &str) -> String {
    let given = Path::new(path);
    let absolute = if given.is_absolute() {
        given.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(given)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

/// Readable Unicode fonts in preference order: the explicit path, the `MIXDOG_OCR_FONT` override, then the platform list.
fn unicode_font_candidates<P: ReadProof>(proof: &P, env: &FontEnv, explicit: &str) -> Vec<String> {
    let mut wanted: Vec<String> = Vec::new();
    if !explicit.is_empty() {
        wanted.push(resolve(explicit));
    }
    if let Some(ocr) = env.ocr_font.as_deref().filter(|path| !path.is_empty()) {
        wanted.push(ocr.to_owned());
    }
    wanted.extend(
        env.system_fonts
            .iter()
            .filter(|path| !path.is_empty())
            .cloned(),
    );
    wanted
        .into_iter()
        .filter(|path| mixdog_fsio::exists(proof, path).unwrap_or(false))
        .collect()
}

/// `unicodeFontPath`: the first readable Unicode font, or an empty string.
pub fn unicode_font_path<P: ReadProof>(proof: &P, env: &FontEnv, explicit: &str) -> String {
    unicode_font_candidates(proof, env, explicit)
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// `😀 (U+1F600)` for each character, for an error that names what blocks the file.
fn describe_uncovered(characters: &[char]) -> String {
    characters
        .iter()
        .map(|character| format!("{character} (U+{:04X})", u32::from(*character)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The bold face that ships beside a regular one: malgun.ttf / malgunbd.ttf, segoeui.ttf / segoeuib.ttf,
/// NanumGothic.ttf / NanumGothicBold.ttf, DejaVuSans.ttf / DejaVuSans-Bold.ttf, a -Regular file and its -Bold.
pub fn bold_companions(path: &str) -> Vec<String> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
        return Vec::new();
    }
    // the file's `(\.\w+)$`: its extension
    let Some(dot) = path.rfind('.') else {
        return Vec::new();
    };
    let (stem, extension) = path.split_at(dot);
    let stem_lower = stem.to_ascii_lowercase();
    let mut found: Vec<String> = Vec::new();
    let mut push = |candidate: String| {
        if candidate != path && !found.contains(&candidate) {
            found.push(candidate);
        }
    };
    if stem_lower.ends_with("-regular") {
        push(format!(
            "{}-Bold{extension}",
            &stem[..stem.len() - "-regular".len()]
        ));
    }
    if stem_lower.ends_with("regular") {
        push(format!(
            "{}Bold{extension}",
            &stem[..stem.len() - "regular".len()]
        ));
    }
    for suffix in ["bd", "b", "-Bold", "Bold"] {
        push(format!("{stem}{suffix}{extension}"));
    }
    found
}

/// What `embedDocumentFont` asks for.
#[derive(Debug, Clone)]
pub struct FontRequest<'a> {
    /// An explicit font file; empty for the standard font or the first installed face that covers the text.
    pub font_path: &'a str,
    /// Every string the document draws (its characters decide whether the standard font will do).
    pub text: &'a str,
    pub standard: StandardFontName,
}

/// The font a document draws with.
#[derive(Debug, Clone)]
pub struct DocumentFont {
    pub font: Font,
    /// The file the face came from; empty for a standard font.
    pub font_path: String,
    pub embedded: bool,
}

/// `embedDocumentFont`: an explicit fontPath always wins; otherwise the standard font when it can encode the text, else
/// the first installed Unicode face that covers it. Refuses with a hint instead of the WinAnsi error when no face does.
pub fn embed_document_font<P: ReadProof>(
    proof: &P,
    env: &FontEnv,
    request: &FontRequest<'_>,
) -> Result<DocumentFont, EmbedError> {
    let explicit = !request.font_path.is_empty();
    if !explicit {
        let builtin = Font::standard(request.standard);
        if builtin.covers(request.text) {
            return Ok(DocumentFont {
                font: builtin.with_stand_ins(),
                font_path: String::new(),
                embedded: false,
            });
        }
    }
    let candidates = unicode_font_candidates(proof, env, request.font_path);
    if explicit && candidates.is_empty() {
        return Err(EmbedError::new(format!(
            "PDF font file was not found: {}",
            request.font_path
        )));
    }
    // The first face that embedded is what the missing characters are reported against: it is the coverage the machine
    // actually has.
    let mut widest: Option<Font> = None;
    let tried: &[String] = if explicit {
        &candidates[..1]
    } else {
        &candidates
    };
    for candidate in tried {
        let font = match mixdog_fsio::read(proof, candidate)
            .map_err(|error| EmbedError::new(error.to_string()))
            .and_then(EmbeddedFace::from_bytes)
        {
            Ok(face) => Font::embedded(face),
            Err(error) => {
                // Collections (.ttc) and damaged files cannot be embedded; an explicit choice reports it, the fallback moves on.
                if explicit {
                    return Err(EmbedError::new(format!(
                        "PDF font {candidate} could not be embedded: {error}"
                    )));
                }
                continue;
            }
        };
        if font.covers(request.text) {
            return Ok(DocumentFont {
                font: font.with_stand_ins(),
                font_path: candidate.clone(),
                embedded: true,
            });
        }
        if explicit {
            let missing = describe_uncovered(&font.uncovered(request.text, 6));
            let shown = if missing.is_empty() {
                "part of the text"
            } else {
                missing.as_str()
            };
            return Err(EmbedError::new(format!(
                "Font {candidate} has no glyph for {shown}; {PDF_FONT_HINT}"
            )));
        }
        widest = widest.or(Some(font));
    }
    // Naming the characters is the difference between a fixable answer and a font hunt: an emoji or a rare ideograph no
    // installed face carries is removed or replaced in the text, while a missing script really does want another font.
    let missing = widest
        .map(|font| describe_uncovered(&font.uncovered(request.text, 6)))
        .unwrap_or_default();
    let (carries, those) = if missing.is_empty() {
        ("characters ".to_owned(), "them")
    } else {
        (format!("{missing} — "), "those characters")
    };
    let cannot = if missing.is_empty() {
        " and the standard PDF fonts cannot encode"
    } else {
        ""
    };
    Err(EmbedError::new(format!(
        "PDF text carries {carries}no installed font covers{cannot}. Replace or remove {those}, or {PDF_FONT_HINT}."
    )))
}

/// `embedBoldFont`: the bold face for headings, table headers, labels and figures: Helvetica-Bold beside Helvetica, else
/// the installed bold companion of the embedded face when it covers the same text. Without one the regular face stands
/// in, so a document without a bold file still writes, only without the weight.
pub fn embed_bold_font<P: ReadProof>(proof: &P, font: &Font, font_path: &str, text: &str) -> Font {
    if font_path.is_empty() {
        return Font::standard(StandardFontName::HelveticaBold).with_stand_ins();
    }
    for candidate in bold_companions(font_path) {
        if !mixdog_fsio::exists(proof, &candidate).unwrap_or(false) {
            continue;
        }
        let Ok(face) = mixdog_fsio::read(proof, &candidate)
            .map_err(|error| EmbedError::new(error.to_string()))
            .and_then(EmbeddedFace::from_bytes)
        else {
            continue;
        };
        let bold = Font::embedded(face);
        if bold.covers(text) {
            return bold.with_stand_ins();
        }
    }
    font.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suffix_counter_is_pdf_libs() {
        let mut rng = SuffixRng::default();
        assert_eq!(rng.name("Font", 4), "Font-7098");
        assert_ne!(rng.name("Font", 4), "Font-7098");
        assert_eq!(rng.name("F", 10), "F-2000805986");
    }

    #[test]
    fn bold_companions_are_the_files_that_ship_beside_a_regular() {
        assert_eq!(
            bold_companions("C:/Fonts/NotoSans-Regular.ttf"),
            vec![
                "C:/Fonts/NotoSans-Bold.ttf",
                "C:/Fonts/NotoSans-Regularbd.ttf",
                "C:/Fonts/NotoSans-Regularb.ttf",
                "C:/Fonts/NotoSans-Regular-Bold.ttf",
                "C:/Fonts/NotoSans-RegularBold.ttf",
            ]
        );
        assert_eq!(
            bold_companions("/f/DejaVuSans.ttf"),
            vec![
                "/f/DejaVuSansbd.ttf",
                "/f/DejaVuSansb.ttf",
                "/f/DejaVuSans-Bold.ttf",
                "/f/DejaVuSansBold.ttf"
            ]
        );
        assert_eq!(
            bold_companions("/f/RobotoRegular.otf")[0],
            "/f/RobotoBold.otf"
        );
        assert!(bold_companions("/f/font.ttc").is_empty());
        assert!(bold_companions("/f/font").is_empty());
    }

    #[test]
    fn a_standard_font_covers_what_its_encoding_or_a_stand_in_has() {
        let font = Font::standard(StandardFontName::Helvetica);
        assert!(font.covers("plain text \u{2212}6 \u{2009}"));
        assert!(!font.covers("한글"));
        assert!(font.covers(""));
        let wrapped = font.with_stand_ins();
        assert_eq!(
            wrapped.encode_text("\u{2212}6").unwrap(),
            font.encode_text("\u{2013}6").unwrap()
        );
        assert_eq!(
            wrapped.width_of_text_at_size("\u{2212}", 10.0).unwrap(),
            font.width_of_text_at_size("\u{2013}", 10.0).unwrap()
        );
        assert!(font.encode_text("\u{2212}").is_err());
    }

    #[test]
    fn describe_names_the_code_points() {
        assert_eq!(describe_uncovered(&['😀', 'é']), "😀 (U+1F600), é (U+00E9)");
    }

    #[test]
    fn resolve_folds_dots() {
        let resolved = resolve("/a/b/../c/./d.ttf");
        assert!(resolved.replace('\\', "/").ends_with("/a/c/d.ttf"));
    }

    #[test]
    fn files_that_are_not_fonts_are_refused_with_the_recorded_texts() {
        assert_eq!(
            EmbeddedFace::from_bytes(b"this is not a font file at all".to_vec())
                .unwrap_err()
                .to_string(),
            "Unknown font format"
        );
        assert_eq!(
            EmbeddedFace::from_bytes(b"ttcf\0\x01\0\0".to_vec())
                .unwrap_err()
                .to_string(),
            "_this.font.createSubset is not a function"
        );
        assert_eq!(
            EmbeddedFace::from_bytes(b"true\0\0\0\0".to_vec())
                .unwrap_err()
                .to_string(),
            "Cannot read properties of undefined (reading 'unitsPerEm')"
        );
    }
}
