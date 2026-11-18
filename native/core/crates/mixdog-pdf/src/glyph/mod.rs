//! Glyph outlines for rendering, following pdf.js 6.4.299 `font_renderer.js`.
//!
//! [`FontRenderer`] draws, as path commands in text space, every font program pdf.js draws as paths in Node: the glyf
//! outlines of TrueType and OpenType, and Type 2 charstrings (bare CFF, CFF-flavoured OpenType, and Type 1 programs
//! converted to Type 2 by [`type1`]). The standard 14 fonts and fonts without a file are substituted by the files
//! [`substitute`] names. Type 3 glyphs are not here: the renderer draws them from their content streams.
//!
//! A path is a flat list of `f32` words like pdf.js's `Float32Array`: the operator ([`MOVE_TO`] and friends) followed by
//! its coordinates, already multiplied by the font matrix.

pub mod substitute;
pub mod truetype;
pub mod type1;
pub mod type2;

use std::collections::{HashMap, HashSet};
use std::fmt;

use truetype::TrueTypeFont;
use type2::Type2Font;

/// A 2D affine matrix `[a, b, c, d, e, f]` as in PDF.
pub type Matrix = [f64; 6];

/// pdf.js `FONT_IDENTITY_MATRIX`: 1000 units per em.
pub const FONT_IDENTITY_MATRIX: Matrix = [0.001, 0.0, 0.0, 0.001, 0.0, 0.0];

/// Path operators, pdf.js `DrawOPS`.
pub const MOVE_TO: f32 = 0.0;
pub const LINE_TO: f32 = 1.0;
pub const CURVE_TO: f32 = 2.0;
pub const QUADRATIC_CURVE_TO: f32 = 3.0;
pub const CLOSE_PATH: f32 = 4.0;

/// Why a font program could not be read or a glyph not drawn (pdf.js throws `FormatError` or a `RangeError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlyphError(pub String);

impl fmt::Display for GlyphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, GlyphError>;

pub(crate) fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(GlyphError(message.into()))
}

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// pdf.js `Util.transform`: the matrix that applies `m2` and then `m1`.
pub(crate) fn multiply(m1: &Matrix, m2: &Matrix) -> Matrix {
    [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]
}

/// pdf.js `Commands`: the path under construction with the transform stack of composite glyphs and seac.
pub(crate) struct Commands {
    cmds: Vec<f32>,
    stack: Vec<Matrix>,
    current: Matrix,
}

impl Commands {
    pub(crate) fn new() -> Self {
        Self {
            cmds: Vec::new(),
            stack: Vec::new(),
            current: IDENTITY,
        }
    }

    /// Adds an operator with points `args` (x, y pairs), each transformed by the current matrix.
    pub(crate) fn add(&mut self, op: f32, args: &[f64]) {
        self.cmds.push(op);
        let m = self.current;
        for pair in args.chunks_exact(2) {
            let (x, y) = (pair[0], pair[1]);
            self.cmds.push((x * m[0] + y * m[2] + m[4]) as f32);
            self.cmds.push((x * m[1] + y * m[3] + m[5]) as f32);
        }
    }

    pub(crate) fn close_path(&mut self) {
        self.cmds.push(CLOSE_PATH);
    }

    pub(crate) fn transform(&mut self, matrix: &Matrix) {
        self.current = multiply(&self.current, matrix);
    }

    pub(crate) fn translate(&mut self, x: f64, y: f64) {
        self.transform(&[1.0, 0.0, 0.0, 1.0, x, y]);
    }

    pub(crate) fn save(&mut self) {
        self.stack.push(self.current);
    }

    pub(crate) fn restore(&mut self) {
        self.current = self.stack.pop().unwrap_or(IDENTITY);
    }

    pub(crate) fn into_path(self) -> Vec<f32> {
        self.cmds
    }
}

/// One `cmap` segment: pdf.js's `{start, end, idDelta, ids}`.
#[derive(Debug, Clone, PartialEq)]
pub struct CmapRange {
    pub start: u32,
    pub end: u32,
    pub id_delta: i64,
    pub ids: Option<Vec<u16>>,
}

/// pdf.js `lookupCmap`: the glyph id of a code point (0 when no segment covers it) by binary search of the segments.
pub fn lookup_cmap(ranges: &[CmapRange], code: u32) -> Result<u16> {
    if ranges.is_empty() {
        return error("Cannot read properties of undefined (reading 'start')");
    }
    let (mut l, mut r) = (0usize, ranges.len() - 1);
    while l < r {
        let c = (l + r + 1) >> 1;
        if code < ranges[c].start {
            r = c - 1;
        } else {
            l = c;
        }
    }
    let range = &ranges[l];
    if range.start <= code && code <= range.end {
        let base = match &range.ids {
            Some(ids) => match ids.get((code - range.start) as usize) {
                Some(id) => i64::from(*id),
                None => return Ok(0),
            },
            None => i64::from(code),
        };
        return Ok(((range.id_delta + base) & 0xffff) as u16);
    }
    Ok(0)
}

enum Program {
    TrueType(TrueTypeFont),
    Type2(Type2Font),
}

/// pdf.js `CompiledFont` and its factory: draws the glyph of a code point of one font program.
pub struct FontRenderer {
    program: Program,
    cmap: Vec<CmapRange>,
    font_matrix: Matrix,
    compiled_glyphs: HashMap<u16, std::result::Result<Vec<f32>, GlyphError>>,
    compiled_char_codes: HashSet<u32>,
}

impl FontRenderer {
    /// pdf.js `FontRendererFactory.create`: reads the tables of an sfnt (`cmap`, `glyf`, `loca`, `head`, `CFF `).
    /// `font_matrix` is the font's own matrix, used for a glyf font without `unitsPerEm` and for CFF; `None` takes
    /// the default of the program kind (0.000488 for glyf, 0.001 for CFF).
    pub fn create(data: &[u8], font_matrix: Option<Matrix>) -> Result<Self> {
        let tables = truetype::read_sfnt(data)?;
        let cmap = tables.cmap.unwrap_or_default();
        if let Some(glyf) = tables.glyf {
            let matrix = match tables.units_per_em {
                Some(upm) if upm != 0 => {
                    let unit = 1.0 / f64::from(upm);
                    [unit, 0.0, 0.0, unit, 0.0, 0.0]
                }
                _ => font_matrix.unwrap_or([0.000488, 0.0, 0.0, 0.000488, 0.0, 0.0]),
            };
            let Some(loca) = tables.loca else {
                return error("Cannot read properties of undefined (reading 'buffer')");
            };
            let font =
                TrueTypeFont::new(&glyf, &loca, tables.index_to_loc_format.unwrap_or(0) != 0)?;
            return Ok(Self::new(Program::TrueType(font), cmap, matrix));
        }
        let Some(cff) = tables.cff else {
            return error("Cannot read properties of undefined (reading 'glyphs')");
        };
        let font = type2::parse_cff(&cff, true)?;
        Ok(Self::new(
            Program::Type2(font),
            cmap,
            font_matrix.unwrap_or(FONT_IDENTITY_MATRIX),
        ))
    }

    /// A renderer over a Type 2 program built elsewhere (a Type 1 font converted by [`type1::Type1Font`]) and the
    /// `cmap` its font object built for it.
    pub fn from_type2(font: Type2Font, cmap: Vec<CmapRange>, font_matrix: Option<Matrix>) -> Self {
        Self::new(
            Program::Type2(font),
            cmap,
            font_matrix.unwrap_or(FONT_IDENTITY_MATRIX),
        )
    }

    /// A renderer over the `glyf` and `loca` tables of a TrueType program, drawn by glyph id (`units_per_em` zero takes
    /// `font_matrix`, as [`FontRenderer::create`] does).
    pub fn from_glyf(
        glyf: &[u8],
        loca: &[u8],
        long_offsets: bool,
        units_per_em: u16,
        font_matrix: Option<Matrix>,
    ) -> Result<Self> {
        let matrix = if units_per_em != 0 {
            let unit = 1.0 / f64::from(units_per_em);
            [unit, 0.0, 0.0, unit, 0.0, 0.0]
        } else {
            font_matrix.unwrap_or([0.000488, 0.0, 0.0, 0.000488, 0.0, 0.0])
        };
        let font = TrueTypeFont::new(glyf, loca, long_offsets)?;
        Ok(Self::new(Program::TrueType(font), Vec::new(), matrix))
    }

    /// The path of glyph `glyph_id` (empty for a glyph without an outline), compiled once.
    pub fn glyph_path(&mut self, glyph_id: u16) -> Result<Vec<f32>> {
        if !self.compiled_glyphs.contains_key(&glyph_id) {
            let compiled = self.compile_glyph(glyph_id);
            self.compiled_glyphs.insert(glyph_id, compiled);
        }
        self.compiled_glyphs[&glyph_id].clone()
    }

    fn new(program: Program, cmap: Vec<CmapRange>, font_matrix: Matrix) -> Self {
        Self {
            program,
            cmap,
            font_matrix,
            compiled_glyphs: HashMap::new(),
            compiled_char_codes: HashSet::new(),
        }
    }

    /// pdf.js `getPath(unicode)` for the code point `code`: the path of its glyph, `None` when this glyph was already
    /// handed out for this code point (the page already has it), or the error pdf.js throws.
    pub fn get_path(&mut self, code: u32) -> Result<Option<Vec<f32>>> {
        let glyph_id = lookup_cmap(&self.cmap, code)?;
        if self.compiled_glyphs.contains_key(&glyph_id) && self.compiled_char_codes.contains(&code)
        {
            return Ok(None);
        }
        if !self.compiled_glyphs.contains_key(&glyph_id) {
            let compiled = self.compile_glyph(glyph_id);
            self.compiled_glyphs.insert(glyph_id, compiled);
        }
        self.compiled_char_codes.insert(code);
        match &self.compiled_glyphs[&glyph_id] {
            Ok(path) => Ok(Some(path.clone())),
            Err(e) => Err(e.clone()),
        }
    }

    fn compile_glyph(&self, glyph_id: u16) -> Result<Vec<f32>> {
        let mut cmds = Commands::new();
        match &self.program {
            Program::TrueType(font) => {
                let Some(code) = font.glyph(usize::from(glyph_id)) else {
                    return Ok(Vec::new());
                };
                if code.is_empty() || code[0] == 14 {
                    return Ok(Vec::new());
                }
                cmds.transform(&self.font_matrix);
                font.compile(usize::from(glyph_id), &mut cmds)?;
            }
            Program::Type2(font) => {
                let Some(code) = font.glyph(usize::from(glyph_id)) else {
                    return Ok(Vec::new());
                };
                if code.is_empty() || code[0] == 14 {
                    return Ok(Vec::new());
                }
                let matrix = font.glyph_font_matrix(usize::from(glyph_id), self.font_matrix)?;
                cmds.transform(&matrix);
                font.compile(usize::from(glyph_id), &mut cmds, &self.cmap)?;
            }
        }
        cmds.close_path();
        Ok(cmds.into_path())
    }
}


impl std::error::Error for GlyphError {}
