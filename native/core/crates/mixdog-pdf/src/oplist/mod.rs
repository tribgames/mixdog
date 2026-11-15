//! The operator-list pass of pdf.js 6.4 (`PartialEvaluator.getOperatorList`): a page's content stream is read with the
//! full evaluator state (`q`/`Q`, `cm`, colour spaces and colours through [`crate::color`], paths and clipping,
//! form XObjects with matrices and bounding boxes, transparency groups and soft masks, images and inline images,
//! marked content, patterns, text state and Type3 glyph procedures) and the pass emits the typed events of
//! [`events::Op`]. They serve the analysis (paths, rectangles, fills and strokes with transforms, image placements
//! with their transform, text shows) and the renderer.
//!
//! The pass runs on the document and page of this crate. Fonts come from a [`FontProvider`], the seam of the font
//! object (pdf.js's `Font`, `PartialEvaluator.translateFont`): it turns a font dictionary into a [`FontObject`] that
//! decodes a shown string into [`Glyph`]s. Without a provider a font is as unavailable as pdf.js's `ErrorFont`: its
//! strings decode to no glyphs.
//!
//! Every operator of the stream passes the document's cancellation check (`Guard::tick`), so a page's parse stops
//! where the caller's cancel check says.

use std::sync::Arc;

use crate::document::Document;
use crate::error::Result;
use crate::object::{Dict, Obj};
use crate::page::Page;
use crate::xref::Xref;

pub mod events;
pub mod gstate;
pub mod interpreter;

pub use events::{
    DRAW_CLOSE_PATH, DRAW_CURVE_TO, DRAW_LINE_TO, DRAW_MOVE_TO, DRAW_QUADRATIC_CURVE_TO,
    Expression, GStateValue, Group, ImageRef, InlineImage, MarkedData, Op, OperatorList,
    OptionalContent, PaintOp, ParamOp, PathData, Pattern, ShadingRef, SoftMask, Subpath, TextItem,
    TilingPattern,
};
pub use gstate::Matrix;

/// JavaScript truthiness of a PDF value.
pub(crate) fn truthy(obj: &Obj) -> bool {
    match obj {
        Obj::Null => false,
        Obj::Bool(b) => *b,
        Obj::Num(n) => *n != 0.0 && !n.is_nan(),
        Obj::Str(s) => !s.is_empty(),
        _ => true,
    }
}

/// pdf.js's `Glyph` as the evaluator hands it on: the character a string code stands for in the font.
#[derive(Debug, Clone, PartialEq)]
pub struct Glyph {
    /// The advance, in thousandths of the text space.
    pub width: f64,
    /// The code in the string (`originalCharCode`).
    pub original_char_code: u32,
    pub font_char: String,
    pub unicode: String,
    pub accent: Option<String>,
    /// The vertical metrics `[w1y, vx, vy]` of a vertical font.
    pub vmetric: Option<[f64; 3]>,
    /// The name of the glyph procedure (Type3 fonts).
    pub operator_list_id: Option<String>,
    pub is_space: bool,
    pub is_in_font: bool,
}

/// A font the evaluator can show text with.
pub trait FontObject {
    fn is_type3(&self) -> bool;

    /// `font.charsToGlyphs(chars)`.
    fn chars_to_glyphs(&self, chars: &[u8]) -> Vec<Glyph>;

    /// `font.bbox`: the `FontBBox` (`[0, 0, 0, 0]` of a Type3 font that has none).
    fn bbox(&self) -> [f64; 4];
}

/// `PartialEvaluator.translateFont`: the font object of a font dictionary.
pub trait FontProvider {
    fn translate_font(&self, dict: &Arc<Dict>, xref: &Xref) -> Result<Arc<dyn FontObject>>;
}

/// The glyph procedures of a Type3 font (`loadType3Data`): one operator list per `CharProcs` entry.
pub struct Type3Data {
    pub procedures: Vec<(String, Arc<OperatorList>)>,
    /// The box the glyph boxes joined to when the font's own is unusable (`font.bbox` with `isCharBBox`).
    pub char_bbox: Option<[f64; 4]>,
}

/// A font as the evaluator keeps it (`TranslatedFont`).
pub struct LoadedFont {
    /// The name `setFont` carries: `g_font_error` for a font that could not be found.
    pub loaded_name: String,
    /// `None` is pdf.js's `ErrorFont`.
    pub font: Option<Arc<dyn FontObject>>,
    pub type3: Option<Type3Data>,
}

/// The font the state holds.
pub type FontHandle = Arc<LoadedFont>;

/// `page.getOperatorList()` as the display layer returns it (the `oplist` intent: no queue optimizer; annotation
/// appearance streams are not part of it): the page's content stream is evaluated. A failure inside the content stream ends the stream and keeps what was read when the document's
/// `ignore_errors` is set (as pdf.js's `ignoreErrors`); a cancellation or a budget failure always propagates.
pub fn get_operator_list(
    document: &Document,
    page: &Page,
    fonts: Option<&dyn FontProvider>,
) -> Result<OperatorList> {
    document.guard().check_now()?;
    let content = page.content(document)?;
    let resources = page.resources(document)?;
    let mut evaluator = interpreter::Evaluator::new(document, fonts, page.index);
    let mut list = OperatorList::new();
    evaluator.get_operator_list(content, None, &resources, &mut list, None, &[])?;
    Ok(list)
}
