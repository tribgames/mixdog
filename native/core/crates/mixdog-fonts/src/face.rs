//! One face of a ttf, otf or ttc file: the names, the style a font manager files it under, the metrics, the variation
//! axes with their named instances, and glyph coverage.
//!
//! The style follows what Skia's FreeType scanner records for a typeface (the weight, width and slant `GlobalFonts`
//! lists): weight 400 (700 when the `head` table says bold) and the upright or italic slant of `head.macStyle`, then,
//! for a face with an OS/2 table, `usWeightClass`, `usWidthClass` and the oblique bit of `fsSelection`. The family is
//! the name FreeType reports: the WWS family, else the typographic family, else the legacy family.

use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_fsio::ReadProof;
use ttf_parser::PlatformId;
use ttf_parser::Tag;
use ttf_parser::name_id;

/// A font could not be read, parsed or measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontError {
    /// The file could not be read.
    Unreadable(String),
    /// The bytes are not a ttf, otf or ttc font (or the face index is outside the file).
    NotAFont(String),
    /// A `ctx.font` string the canvas refuses.
    InvalidFont(String),
    /// Text the canvas cannot take (an embedded NUL).
    InvalidText,
}

impl fmt::Display for FontError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable(why) | Self::NotAFont(why) => out.write_str(why),
            Self::InvalidFont(text) => write!(out, "[`{text}`] is not valid font style"),
            Self::InvalidText => out.write_str("Convert String to CString failed"),
        }
    }
}

impl std::error::Error for FontError {}

/// The slant of a face or of a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slant {
    Upright,
    Italic,
    Oblique,
}

/// What a font manager matches on: the weight (1..=1000), the width (1..=9, 5 normal) and the slant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontStyle {
    pub weight: u16,
    pub width: u8,
    pub slant: Slant,
}

impl FontStyle {
    pub const NORMAL: Self = Self { weight: 400, width: 5, slant: Slant::Upright };
}

/// A variation axis of the `fvar` table.
#[derive(Debug, Clone, PartialEq)]
pub struct Axis {
    /// The four-letter tag (`wght`).
    pub tag: String,
    pub min: f32,
    pub default: f32,
    pub max: f32,
    pub name: Option<String>,
    pub hidden: bool,
}

/// A named instance of the `fvar` table: a name and a position on every axis.
#[derive(Debug, Clone, PartialEq)]
pub struct NamedInstance {
    pub name: Option<String>,
    pub postscript_name: Option<String>,
    /// `(axis tag, coordinate)` in axis order.
    pub coordinates: Vec<(String, f32)>,
}

/// The vertical metrics FreeType reports, in font units (`descender` is negative).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerticalMetrics {
    pub ascender: i16,
    pub descender: i16,
    pub line_gap: i16,
}

/// A parsed face: what was read from it, and its bytes (shared by the faces of a collection). A face found by a scan
/// keeps its path and no bytes; they are read the first time the face is used ([`Face::ensure_loaded`]), so a scan of
/// every font of the machine does not hold them all in memory.
pub struct Face {
    data: OnceLock<Arc<[u8]>>,
    path: Option<PathBuf>,
    index: u32,
    pub family: String,
    /// Name id 1, the family the face's own style names refer to.
    pub legacy_family: String,
    pub subfamily: String,
    pub full_name: String,
    pub postscript_name: String,
    pub style: FontStyle,
    pub units_per_em: u16,
    pub metrics: VerticalMetrics,
    pub glyph_count: u16,
    pub axes: Vec<Axis>,
    pub instances: Vec<NamedInstance>,
}

impl fmt::Debug for Face {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_struct("Face")
            .field("family", &self.family)
            .field("style", &self.style)
            .field("index", &self.index)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

fn be_u16(table: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*table.get(at)?, *table.get(at + 1)?]))
}

fn be_i16(table: &[u8], at: usize) -> Option<i16> {
    be_u16(table, at).map(|value| value as i16)
}

/// The string of name `id`: Windows English, any Windows, Unicode, then Mac Roman English (FreeType's order).
fn best_name(face: &ttf_parser::Face<'_>, id: u16) -> Option<String> {
    let mut windows_english = None;
    let mut windows = None;
    let mut unicode = None;
    let mut mac = None;
    for name in face.names() {
        if name.name_id != id {
            continue;
        }
        let Some(text) = name.to_string() else { continue };
        match name.platform_id {
            PlatformId::Windows if name.language_id == 0x409 => windows_english = windows_english.or(Some(text)),
            PlatformId::Windows => windows = windows.or(Some(text)),
            PlatformId::Unicode => unicode = unicode.or(Some(text)),
            PlatformId::Macintosh if name.language_id == 0 => mac = mac.or(Some(text)),
            _ => {}
        }
    }
    windows_english.or(windows).or(unicode).or(mac)
}

fn font_style(raw: &ttf_parser::RawFace<'_>) -> FontStyle {
    let mac_style = raw.table(Tag::from_bytes(b"head")).and_then(|head| be_u16(head, 44)).unwrap_or(0);
    let mut weight = if mac_style & 1 != 0 { 700 } else { 400 };
    let mut width = 5;
    let mut slant = if mac_style & 2 != 0 { Slant::Italic } else { Slant::Upright };
    if let Some(os2) = raw.table(Tag::from_bytes(b"OS/2")) {
        if be_u16(os2, 0) != Some(0xFFFF) {
            weight = be_u16(os2, 4).unwrap_or(weight);
            width = be_u16(os2, 6).unwrap_or(5);
            if be_u16(os2, 62).is_some_and(|selection| selection & (1 << 9) != 0) {
                slant = Slant::Oblique;
            }
        }
    }
    FontStyle { weight: weight.min(1000), width: width.clamp(1, 9) as u8, slant }
}

/// FreeType's `ascender` and `descender`: the `hhea` pair, else the OS/2 typographic pair, else the Windows pair.
fn vertical_metrics(face: &ttf_parser::Face<'_>, raw: &ttf_parser::RawFace<'_>) -> VerticalMetrics {
    let hhea = VerticalMetrics { ascender: face.ascender(), descender: face.descender(), line_gap: face.line_gap() };
    if hhea.ascender != 0 || hhea.descender != 0 {
        return hhea;
    }
    let Some(os2) = raw.table(Tag::from_bytes(b"OS/2")) else { return hhea };
    let typographic = VerticalMetrics {
        ascender: be_i16(os2, 68).unwrap_or(0),
        descender: be_i16(os2, 70).unwrap_or(0),
        line_gap: be_i16(os2, 72).unwrap_or(0),
    };
    if typographic.ascender != 0 || typographic.descender != 0 {
        return typographic;
    }
    let win_descent = be_u16(os2, 76).unwrap_or(0) as i16;
    VerticalMetrics { ascender: be_u16(os2, 74).unwrap_or(0) as i16, descender: win_descent.wrapping_neg(), line_gap: hhea.line_gap }
}

fn axes_of(face: &ttf_parser::Face<'_>) -> Vec<Axis> {
    face.variation_axes()
        .into_iter()
        .map(|axis| Axis {
            tag: axis.tag.to_string(),
            min: axis.min_value,
            default: axis.def_value,
            max: axis.max_value,
            name: best_name(face, axis.name_id),
            hidden: axis.hidden,
        })
        .collect()
}

/// The named instances of the `fvar` table, which ttf-parser does not expose.
fn instances_of(face: &ttf_parser::Face<'_>, raw: &ttf_parser::RawFace<'_>, axes: &[Axis]) -> Vec<NamedInstance> {
    let Some(fvar) = raw.table(Tag::from_bytes(b"fvar")) else { return Vec::new() };
    let (Some(axes_offset), Some(count), Some(axis_size), Some(instance_count), Some(instance_size)) =
        (be_u16(fvar, 4), be_u16(fvar, 8), be_u16(fvar, 10), be_u16(fvar, 12), be_u16(fvar, 14))
    else {
        return Vec::new();
    };
    let start = usize::from(axes_offset) + usize::from(count) * usize::from(axis_size);
    let has_postscript = usize::from(instance_size) >= 4 + usize::from(count) * 4 + 2;
    let mut out = Vec::new();
    for index in 0..usize::from(instance_count) {
        let at = start + index * usize::from(instance_size);
        let Some(name_id) = be_u16(fvar, at) else { break };
        let mut coordinates = Vec::with_capacity(axes.len());
        for (axis_index, axis) in axes.iter().enumerate() {
            let (Some(high), Some(low)) = (be_i16(fvar, at + 4 + axis_index * 4), be_u16(fvar, at + 6 + axis_index * 4)) else { break };
            coordinates.push((axis.tag.clone(), f32::from(high) + f32::from(low) / 65536.0));
        }
        let postscript = if has_postscript { be_u16(fvar, at + 4 + usize::from(count) * 4) } else { None };
        out.push(NamedInstance {
            name: best_name(face, name_id),
            postscript_name: postscript.filter(|id| *id != 0xFFFF).and_then(|id| best_name(face, id)),
            coordinates,
        });
    }
    out
}

impl Face {
    /// What a face is described by, read from font bytes without keeping them.
    fn describe(data: &[u8], index: u32) -> Result<Self, FontError> {
        let face = ttf_parser::Face::parse(data, index).map_err(|error| FontError::NotAFont(format!("not a font: {error}")))?;
        let raw = face.raw_face();
        let legacy_family = best_name(&face, name_id::FAMILY).unwrap_or_default();
        let family = best_name(&face, name_id::WWS_FAMILY)
            .or_else(|| best_name(&face, name_id::TYPOGRAPHIC_FAMILY))
            .unwrap_or_else(|| legacy_family.clone());
        let axes = axes_of(&face);
        let instances = instances_of(&face, raw, &axes);
        Ok(Self {
            family,
            legacy_family,
            subfamily: best_name(&face, name_id::SUBFAMILY).unwrap_or_default(),
            full_name: best_name(&face, name_id::FULL_NAME).unwrap_or_default(),
            postscript_name: best_name(&face, name_id::POST_SCRIPT_NAME).unwrap_or_default(),
            style: font_style(raw),
            units_per_em: face.units_per_em(),
            metrics: vertical_metrics(&face, raw),
            glyph_count: face.number_of_glyphs(),
            axes,
            instances,
            index,
            path: None,
            data: OnceLock::new(),
        })
    }

    /// The face `index` of font file bytes, which it keeps.
    pub fn new(data: Arc<[u8]>, index: u32) -> Result<Self, FontError> {
        let face = Self::describe(&data, index)?;
        let _ = face.data.set(data);
        Ok(face)
    }

    /// The first face of the file at `path`, described from `data` (the file's bytes), which are not kept: the face
    /// reads the file again when it is first used.
    pub fn described(path: &Path, data: &[u8]) -> Result<Self, FontError> {
        let mut face = Self::describe(data, 0)?;
        face.path = Some(path.to_path_buf());
        Ok(face)
    }

    /// Every face of font file bytes: one for a ttf or otf, one per member for a ttc.
    pub fn load_all(data: Vec<u8>) -> Result<Vec<Self>, FontError> {
        let data: Arc<[u8]> = Arc::from(data);
        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        (0..count).map(|index| Self::new(Arc::clone(&data), index)).collect()
    }

    /// The first face of the file at `path` (what `GlobalFonts.registerFromPath` registers).
    pub fn from_file<P: ReadProof>(proof: &P, path: &Path) -> Result<Self, FontError> {
        let bytes = mixdog_fsio::read(proof, path).map_err(|error| FontError::Unreadable(format!("{}: {error}", path.display())))?;
        let mut face = Self::new(Arc::from(bytes), 0)?;
        face.path = Some(path.to_path_buf());
        Ok(face)
    }

    /// The file the face was found in, when it came from one.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The file bytes once loaded (shared with the other faces of a collection).
    pub fn bytes(&self) -> Option<&Arc<[u8]>> {
        self.data.get()
    }

    /// Reads the file when the face holds no bytes yet. A face with neither bytes nor a path cannot be loaded.
    pub fn ensure_loaded<P: ReadProof>(&self, proof: &P) -> Result<&Arc<[u8]>, FontError> {
        if let Some(data) = self.data.get() {
            return Ok(data);
        }
        let path = self.path.as_deref().ok_or_else(|| FontError::Unreadable("the face has no bytes and no file".to_owned()))?;
        let bytes = mixdog_fsio::read(proof, path).map_err(|error| FontError::Unreadable(format!("{}: {error}", path.display())))?;
        Ok(self.data.get_or_init(|| Arc::from(bytes)))
    }

    /// The face index in a collection (0 for a single font).
    pub fn index(&self) -> u32 {
        self.index
    }

    /// The face for reading tables and glyphs, once its bytes are loaded. Parsing reads the table directory only.
    pub fn parsed(&self) -> Option<ttf_parser::Face<'_>> {
        ttf_parser::Face::parse(self.data.get()?, self.index).ok()
    }

    /// True when the cmap maps `character` to a glyph.
    pub fn has_glyph(&self, character: char) -> bool {
        self.parsed().is_some_and(|face| face.glyph_index(character).is_some())
    }

    /// True for a face with a `fvar` table.
    pub fn is_variable(&self) -> bool {
        !self.axes.is_empty()
    }
}

#[cfg(test)]
impl Face {
    /// A face with no font data and the given family: tests of the registry and of matching only.
    pub(crate) fn stub(family: &str) -> Self {
        Self {
            data: OnceLock::new(),
            path: None,
            index: 0,
            family: family.to_owned(),
            legacy_family: family.to_owned(),
            subfamily: String::new(),
            full_name: String::new(),
            postscript_name: String::new(),
            style: FontStyle::NORMAL,
            units_per_em: 1000,
            metrics: VerticalMetrics { ascender: 800, descender: -200, line_gap: 0 },
            glyph_count: 1,
            axes: Vec::new(),
            instances: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal sfnt: the tables `ttf_parser` needs (head, hhea, maxp) plus the ones under test.
    fn sfnt(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 1, 0, 0];
        out.extend((tables.len() as u16).to_be_bytes());
        out.extend([0; 6]);
        let mut offset = 12 + 16 * tables.len();
        let mut body = Vec::new();
        for (tag, table) in tables {
            out.extend(tag.iter());
            out.extend([0; 4]);
            out.extend((offset as u32).to_be_bytes());
            out.extend((table.len() as u32).to_be_bytes());
            body.extend(table);
            while body.len() % 4 != 0 {
                body.push(0);
            }
            offset = 12 + 16 * tables.len() + body.len();
        }
        out.extend(body);
        out
    }

    fn head(mac_style: u16) -> Vec<u8> {
        let mut table = vec![0; 54];
        table[18..20].copy_from_slice(&1000u16.to_be_bytes());
        table[44..46].copy_from_slice(&mac_style.to_be_bytes());
        table
    }

    fn hhea(ascender: i16, descender: i16) -> Vec<u8> {
        let mut table = vec![0; 36];
        table[4..6].copy_from_slice(&ascender.to_be_bytes());
        table[6..8].copy_from_slice(&descender.to_be_bytes());
        table[34..36].copy_from_slice(&1u16.to_be_bytes());
        table
    }

    fn maxp() -> Vec<u8> {
        let mut table = vec![0, 0, 0x50, 0];
        table.extend(1u16.to_be_bytes());
        table
    }

    fn os2(weight: u16, width: u16, selection: u16) -> Vec<u8> {
        let mut table = vec![0; 78];
        table[4..6].copy_from_slice(&weight.to_be_bytes());
        table[6..8].copy_from_slice(&width.to_be_bytes());
        table[62..64].copy_from_slice(&selection.to_be_bytes());
        table[68..70].copy_from_slice(&800i16.to_be_bytes());
        table[70..72].copy_from_slice(&(-200i16).to_be_bytes());
        table[74..76].copy_from_slice(&900u16.to_be_bytes());
        table[76..78].copy_from_slice(&250u16.to_be_bytes());
        table
    }

    fn face(tables: Vec<(&[u8; 4], Vec<u8>)>) -> Face {
        Face::new(Arc::from(sfnt(&tables)), 0).expect("a face")
    }

    #[test]
    fn the_style_comes_from_the_os2_table_when_there_is_one() {
        let bold_italic = face(vec![(b"head", head(3)), (b"hhea", hhea(1, -1)), (b"maxp", maxp())]);
        assert_eq!(bold_italic.style, FontStyle { weight: 700, width: 5, slant: Slant::Italic });
        let with_os2 = face(vec![(b"OS/2", os2(300, 3, 1 << 9)), (b"head", head(0)), (b"hhea", hhea(1, -1)), (b"maxp", maxp())]);
        assert_eq!(with_os2.style, FontStyle { weight: 300, width: 3, slant: Slant::Oblique });
    }

    #[test]
    fn the_vertical_metrics_fall_back_from_hhea_to_the_os2_pairs() {
        let hhea_pair = face(vec![(b"OS/2", os2(400, 5, 0)), (b"head", head(0)), (b"hhea", hhea(700, -300)), (b"maxp", maxp())]);
        assert_eq!((hhea_pair.metrics.ascender, hhea_pair.metrics.descender), (700, -300));
        let typographic = face(vec![(b"OS/2", os2(400, 5, 0)), (b"head", head(0)), (b"hhea", hhea(0, 0)), (b"maxp", maxp())]);
        assert_eq!((typographic.metrics.ascender, typographic.metrics.descender), (800, -200));
    }

    #[test]
    fn bytes_that_are_not_a_font_are_refused() {
        assert!(matches!(Face::new(Arc::from(vec![1, 2, 3, 4]), 0), Err(FontError::NotAFont(_))));
    }

    #[test]
    fn the_canvas_error_texts_are_kept() {
        assert_eq!(FontError::InvalidFont("Arial".into()).to_string(), "[`Arial`] is not valid font style");
        assert_eq!(FontError::InvalidText.to_string(), "Convert String to CString failed");
    }
}
