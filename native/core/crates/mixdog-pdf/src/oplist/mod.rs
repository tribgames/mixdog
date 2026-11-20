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
    DRAW_CLOSE_PATH, DRAW_CURVE_TO, DRAW_LINE_TO, DRAW_MOVE_TO, DRAW_QUADRATIC_CURVE_TO, Expression, GStateValue, Group, ImageRef, InlineImage, MarkedData, Op,
    OperatorList, OptionalContent, PaintOp, ParamOp, PathData, Pattern, ShadingRef, SoftMask, Subpath, TextItem, TilingPattern,
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

    /// The name the evaluator gave a font [`translate_font`](Self::translate_font) returned (`loadedName`: what the
    /// operator list's `setFont` carries). A provider whose fonts draw learns here which font a name stands for.
    fn font_loaded(&self, _loaded_name: &str, _font: &Arc<dyn FontObject>) {}
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

/// The page part of `page.getOperatorList()` (the `oplist` intent: no queue optimizer): the page's content stream is
/// evaluated with the page's resources merged under the content stream's own. pdf.js's list (display intent,
/// `AnnotationMode.ENABLE`) continues with the operator lists of the viewable annotations' appearance streams
/// (`beginAnnotation` ... `endAnnotation`); those are [`get_operator_list_with_annotations`]. A failure inside the content stream ends the
/// stream and keeps what was read when the document's `ignore_errors` is set (as pdf.js's `ignoreErrors`); a
/// cancellation or a budget failure always propagates.
pub fn get_operator_list(document: &Document, page: &Page, fonts: Option<&dyn FontProvider>) -> Result<OperatorList> {
    Ok(get_page_operators(document, page, fonts)?.list)
}

/// `page.getOperatorList()` as pdf.js's display intent makes it with `AnnotationMode.ENABLE`: the page's operators, then the
/// appearance stream of every viewable annotation that has one (a widget included: the forms are drawn on the canvas in
/// this mode), in the order [`crate::annotations::get_annotations`] gives. pdf.js brackets each between `beginAnnotation`
/// and `endAnnotation`; the analysis ignores both, so they are not added. An annotation whose appearance cannot be read
/// is left out (pdf.js warns `ignoring annotation data`); a cancellation or a budget failure propagates.
pub fn get_operator_list_with_annotations(document: &Document, page: &Page, fonts: Option<&dyn FontProvider>) -> Result<OperatorList> {
    document.guard().check_now()?;
    let content = page.content(document)?;
    let resources = merged_resources(document, page)?;
    let mut evaluator = interpreter::Evaluator::new(document, fonts, page.index);
    let mut list = OperatorList::new();
    evaluator.get_operator_list(content, None, &resources, &mut list, None, &[])?;
    let xref = document.xref();
    let filters = xref.filters();
    for annotation in crate::annotations::get_annotations(document, page)? {
        // `mustBeViewed`: viewable (what `get_annotations` keeps) and not `AnnotationFlag.HIDDEN` (2).
        if annotation.annotation_flags & 2 != 0 {
            continue;
        }
        let Some(Obj::Stream(stream)) = annotation.appearance else {
            continue;
        };
        let mut own = OperatorList::new();
        let read = (|| -> Result<()> {
            let bytes = stream.decode(filters.as_ref(), xref.guard())?;
            let resources = match xref.get(&stream.dict, "Resources")? {
                Obj::Dict(resources) => resources,
                _ => Arc::new(Dict::new()),
            };
            evaluator.get_operator_list(bytes, None, &resources, &mut own, None, &[])
        })();
        match read {
            Ok(()) => list.add_op_list(own),
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => tracing::warn!("getOperatorList - ignoring annotation data during \"OperatorList\" task: \"{e}\"."),
        }
    }
    Ok(list)
}

/// A page's operator list with the fonts it was made with: what the display layer holds in `commonObjs`, the glyph
/// procedures of the Type3 fonts (`charProcOperatorList`) among them.
pub struct PageOperators {
    pub list: OperatorList,
    pub fonts: Vec<FontHandle>,
}

/// [`get_operator_list`] and the fonts the list names.
pub fn get_page_operators(document: &Document, page: &Page, fonts: Option<&dyn FontProvider>) -> Result<PageOperators> {
    document.guard().check_now()?;
    let content = page.content(document)?;
    let resources = merged_resources(document, page)?;
    let mut evaluator = interpreter::Evaluator::new(document, fonts, page.index);
    let mut list = OperatorList::new();
    evaluator.get_operator_list(content, None, &resources, &mut list, None, &[])?;
    Ok(PageOperators { list, fonts: evaluator.into_fonts() })
}

/// `Page.#getMergedResources`: when `/Contents` is one stream with a non-empty `/Resources` of its own, that
/// dictionary is merged over the page's (its entries first, sub-dictionaries merged key by key); otherwise the
/// page's resources. (An image stream as `/Contents` has no content, so its resources never matter.)
fn merged_resources(document: &Document, page: &Page) -> Result<Arc<Dict>> {
    let xref = document.xref();
    let page_resources = page.resources(document)?;
    let Obj::Stream(stream) = xref.get(&page.dict, "Contents")? else {
        return Ok(page_resources);
    };
    let local = match xref.get(&stream.dict, "Resources")? {
        Obj::Dict(local) if !local.is_empty() => local,
        _ => return Ok(page_resources),
    };
    let merged = Dict::merge(&[Obj::Dict(local), Obj::Dict(page_resources)], true);
    Ok(Arc::new(merged.unwrap_or_default()))
}
