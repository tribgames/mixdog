//! `PartialEvaluator.getTextContent` of pdf.js 6.4 (default options: no marked-content items, normalisation on,
//! white space kept as pdf.js's item builder has it): the content stream is read with the text state, fonts come
//! from the document's [`FontLoader`], form XObjects are read with their own matrix and resources, and the show
//! operators go to the item [`Builder`].
//!
//! A failure inside a stream ends the stream and keeps the items made so far when the document's `ignore_errors` is
//! set (as pdf.js's `ignoreErrors`); a failure of one `Do` or `gs` only skips that operator. Cancellation and budget
//! failures always propagate.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::fonts::font::{
    CharProcFirstOp, FONT_IDENTITY_MATRIX, FontLoader, LoadContext, Type3CharProcs,
};
use crate::object::{Dict, Obj, Ref};
use crate::oplist::interpreter;
use crate::oplist::{Op, OperatorList, ParamOp, truthy};
use crate::xref::Xref;

use super::TextContent;
use super::builder::{Builder, Chars};
use super::operators::{Preprocessor, TextOp, number_at};
use super::state::{StateManager, TextState};

/// How deep form XObjects are followed (pdf.js has no bound but its cycle guard; a stream that nests deeper is
/// skipped like one whose form fails).
const MAX_FORM_DEPTH: usize = 64;

/// The glyph descriptions of a Type 3 font, read far enough to give the font its bounding box (`loadType3Data`).
struct Type3Scan<'a> {
    document: &'a Document,
}

impl Type3CharProcs for Type3Scan<'_> {
    fn first_operation(
        &self,
        char_proc: &Obj,
        resources: &Dict,
        _font_ref: Option<Ref>,
    ) -> CharProcFirstOp {
        let Obj::Stream(stream) = char_proc else {
            return CharProcFirstOp::Other;
        };
        let xref = self.document.xref();
        let filters = xref.filters();
        let Ok(content) = stream.decode(filters.as_ref(), xref.guard()) else {
            return CharProcFirstOp::Other;
        };
        let resources = Arc::new(resources.clone());
        let mut evaluator = interpreter::Evaluator::new(self.document, None, 0);
        let mut list = OperatorList::new();
        if evaluator
            .get_operator_list(
                content,
                stream.dict.obj_id.as_deref(),
                &resources,
                &mut list,
                None,
                &[],
            )
            .is_err()
        {
            return CharProcFirstOp::Other;
        }
        match list.ops().first() {
            Some(Op::Param(ParamOp::SetCharWidthAndBounds, args)) => {
                let mut bounds = [0.0; 6];
                for (i, bound) in bounds.iter_mut().enumerate() {
                    *bound = number_at(args, i);
                }
                CharProcFirstOp::WidthAndBounds(bounds)
            }
            Some(Op::Param(ParamOp::SetCharWidth, _)) => {
                // `#guessType3FontBBox` starts the box, then spreads each path's `minMax` into it; a path painted
                // with no segments has none, the spread throws and the paths after it count no more. A box of NaN
                // starts the box and leaves it as it is (`min` and `max` keep the other operand).
                let mut path_bounds = Vec::new();
                for op in list.ops().iter().skip(1) {
                    if let Op::ConstructPath { path, .. } = op {
                        match path {
                            Some(path) => path_bounds.push(path.min_max.map(f64::from)),
                            None => {
                                path_bounds.push([f64::NAN; 4]);
                                break;
                            }
                        }
                    }
                }
                CharProcFirstOp::Width { path_bounds }
            }
            _ => CharProcFirstOp::Other,
        }
    }
}

/// `LocalImageCache` as `getTextContent` uses it for XObjects that showed nothing (`emptyXObjectCache`): looked up
/// by name, and by reference when the object has one.
#[derive(Default)]
struct EmptyCache {
    name_ref: HashMap<String, String>,
    by_ref: HashSet<String>,
    by_name: HashSet<String>,
}

impl EmptyCache {
    fn get_by_name(&self, name: &str) -> bool {
        match self.name_ref.get(name) {
            Some(reference) => self.by_ref.contains(reference),
            None => self.by_name.contains(name),
        }
    }

    fn set(&mut self, name: &str, reference: Option<&str>) {
        match reference.filter(|reference| !reference.is_empty()) {
            Some(reference) => {
                if self.by_ref.contains(reference) {
                    return;
                }
                self.name_ref.insert(name.to_owned(), reference.to_owned());
                self.by_ref.insert(reference.to_owned());
            }
            None => {
                self.by_name.insert(name.to_owned());
            }
        }
    }
}

/// `isNumberArray(arr, 6)` of a `Matrix`.
fn lookup_matrix(obj: &Obj) -> Option<[f64; 6]> {
    let Obj::Array(items) = obj else {
        return None;
    };
    let values: Vec<f64> = items.iter().filter_map(Obj::as_num).collect();
    if values.len() != items.len() {
        return None;
    }
    <[f64; 6]>::try_from(values).ok()
}

/// What a show operator shows: an empty or false value shows nothing but the spacing, a string its glyphs.
fn chars_of<'b>(state: &TextState, arg: Option<&'b Obj>) -> Result<Chars<'b>> {
    match arg {
        None => Ok(Chars::Empty),
        Some(Obj::Str(bytes)) if bytes.is_empty() => Ok(Chars::Empty),
        Some(Obj::Str(bytes)) => Ok(Chars::Bytes(&bytes[..])),
        Some(obj) if !truthy(obj) => Ok(Chars::Empty),
        Some(Obj::Array(items))
            if !items.is_empty()
                && state
                    .font
                    .as_ref()
                    .is_some_and(|font| font.font().is_some()) =>
        {
            Err(PdfError::Unknown(
                "chars.charCodeAt is not a function".to_owned(),
            ))
        }
        Some(_) => Ok(Chars::NoGlyphs),
    }
}

/// The reader of one document's text: the document, its fonts and the page's view box.
pub struct Evaluator<'a> {
    document: &'a Document,
    xref: &'a Xref,
    fonts: &'a FontLoader,
    view_box: [f64; 4],
    ignore_errors: bool,
    type3: Type3Scan<'a>,
    no_refs: HashSet<Ref>,
}

impl<'a> Evaluator<'a> {
    pub fn new(document: &'a Document, fonts: &'a FontLoader, view_box: [f64; 4]) -> Self {
        Evaluator {
            document,
            xref: document.xref(),
            fonts,
            view_box,
            ignore_errors: document.options().ignore_errors,
            type3: Type3Scan { document },
            no_refs: HashSet::new(),
        }
    }

    /// `getTextContent` of a stream: the items go to `sink` in the order pdf.js enqueues them. `stream_id` is the
    /// reference the stream was fetched as (a form met again through itself is an error), `prev_refs` the forms that
    /// are being read around it.
    #[allow(clippy::too_many_arguments)]
    pub fn get_text_content(
        &self,
        content: Vec<u8>,
        stream_id: Option<&str>,
        resources: &Arc<Dict>,
        mut manager: StateManager,
        prev_refs: &[String],
        sink: &mut TextContent,
        depth: usize,
    ) -> Result<()> {
        let mut seen: Vec<String> = prev_refs.to_vec();
        if let Some(id) = stream_id {
            if prev_refs.iter().any(|reference| reference == id) {
                return Err(PdfError::Format(format!(
                    "getTextContent - ignoring circular reference: {id}"
                )));
            }
            seen.push(id.to_owned());
        }
        let mut pre = Preprocessor::new(content, self.xref)?;
        let mut builder = Builder::new(sink, self.view_box);
        let mut cache = EmptyCache::default();
        let outcome = self.run(
            &mut pre,
            &mut manager,
            resources,
            &mut builder,
            &mut cache,
            &seen,
            depth,
        );
        match outcome {
            Ok(()) => {
                builder.flush();
                Ok(())
            }
            Err(error) if error.is_fatal() => Err(error),
            Err(error) if self.ignore_errors => {
                tracing::warn!(
                    "getTextContent - ignoring errors during \"TextContent\" task: \"{error}\"."
                );
                builder.flush();
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    /// An error of one operator that pdf.js's own `.catch` swallows under `ignoreErrors` and throws otherwise.
    fn swallow(&self, what: &str, outcome: Result<()>) -> Result<()> {
        match outcome {
            Err(error) if error.is_fatal() => Err(error),
            Err(error) if self.ignore_errors => {
                tracing::warn!("getTextContent - ignoring {what}: \"{error}\".");
                Ok(())
            }
            other => other,
        }
    }

    /// `ensureStateFont`: a text operator before any `Tf` is skipped (and an error without `ignoreErrors`).
    fn ensure_state_font(&self) -> Result<()> {
        let message = "Missing setFont (Tf) operator before text rendering operator.";
        if self.ignore_errors {
            tracing::warn!("ensureStateFont: \"{message}\".");
            Ok(())
        } else {
            Err(PdfError::Format(message.to_owned()))
        }
    }

    /// `handleSetFont`: the font becomes the state's font.
    fn handle_set_font(
        &self,
        font_name: Option<&str>,
        font: Option<&Obj>,
        resources: &Dict,
        state: &mut TextState,
    ) -> Result<()> {
        let context = LoadContext {
            type3_font_refs: &self.no_refs,
            parsing_type3_font: false,
            type3: &self.type3,
        };
        let translated = self
            .fonts
            .load_font(self.xref, font_name, font, resources, &context)?;
        state.loaded_name = Some(translated.loaded_name.clone());
        state.font_matrix = translated
            .font()
            .and_then(|font| font.font_matrix)
            .unwrap_or(FONT_IDENTITY_MATRIX);
        state.font = Some(translated);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &self,
        pre: &mut Preprocessor<'_>,
        manager: &mut StateManager,
        resources: &Arc<Dict>,
        builder: &mut Builder<'_>,
        cache: &mut EmptyCache,
        seen: &[String],
        depth: usize,
    ) -> Result<()> {
        loop {
            self.xref.guard().tick()?;
            let Some((op, args)) = pre.read(manager)? else {
                return Ok(());
            };
            builder.note_state(&manager.state);
            match op {
                TextOp::SetFont => {
                    let name = args.first().and_then(Obj::as_name).map(str::to_owned);
                    let size = number_at(&args, 1);
                    let state = &mut manager.state;
                    if state.font.is_some()
                        && name.is_some()
                        && name == state.font_name
                        && size == state.font_size
                    {
                        continue;
                    }
                    state.font_name.clone_from(&name);
                    state.font_size = size;
                    self.handle_set_font(name.as_deref(), None, resources, state)?;
                }
                TextOp::SetTextRise => manager.state.text_rise = number_at(&args, 0),
                TextOp::SetHScale => manager.state.text_h_scale = number_at(&args, 0) / 100.0,
                TextOp::SetLeading => manager.state.leading = number_at(&args, 0),
                TextOp::MoveText => {
                    let state = &mut manager.state;
                    state.translate_text_line_matrix(number_at(&args, 0), number_at(&args, 1));
                    state.text_matrix = state.text_line_matrix;
                }
                TextOp::SetLeadingMoveText => {
                    let state = &mut manager.state;
                    state.leading = -number_at(&args, 1);
                    state.translate_text_line_matrix(number_at(&args, 0), number_at(&args, 1));
                    state.text_matrix = state.text_line_matrix;
                }
                TextOp::NextLine => manager.state.carriage_return(),
                TextOp::SetTextMatrix => {
                    let m: [f64; 6] = std::array::from_fn(|i| number_at(&args, i));
                    manager.state.set_text_matrix(m);
                    manager.state.set_text_line_matrix(m);
                    builder.update_advance_scale(&manager.state);
                }
                TextOp::SetCharSpacing => manager.state.char_spacing = number_at(&args, 0),
                TextOp::SetWordSpacing => manager.state.word_spacing = number_at(&args, 0),
                TextOp::BeginText => {
                    manager.state.text_matrix = crate::oplist::gstate::IDENTITY;
                    manager.state.text_line_matrix = crate::oplist::gstate::IDENTITY;
                }
                TextOp::ShowSpacedText => {
                    if manager.state.font.is_none() {
                        self.ensure_state_font()?;
                        continue;
                    }
                    self.show_spaced_text(args.first(), builder, &mut manager.state)?;
                }
                TextOp::ShowText => {
                    if manager.state.font.is_none() {
                        self.ensure_state_font()?;
                        continue;
                    }
                    let chars = chars_of(&manager.state, args.first())?;
                    builder.build_text_content_item(&mut manager.state, chars, 0.0)?;
                }
                TextOp::NextLineShowText => {
                    if manager.state.font.is_none() {
                        self.ensure_state_font()?;
                        continue;
                    }
                    manager.state.carriage_return();
                    let chars = chars_of(&manager.state, args.first())?;
                    builder.build_text_content_item(&mut manager.state, chars, 0.0)?;
                }
                TextOp::NextLineSetSpacingShowText => {
                    if manager.state.font.is_none() {
                        self.ensure_state_font()?;
                        continue;
                    }
                    manager.state.word_spacing = number_at(&args, 0);
                    manager.state.char_spacing = number_at(&args, 1);
                    manager.state.carriage_return();
                    let chars = chars_of(&manager.state, args.get(2))?;
                    builder.build_text_content_item(&mut manager.state, chars, 0.0)?;
                }
                TextOp::PaintXObject => {
                    builder.flush();
                    let name = args.first().and_then(Obj::as_name);
                    if let Some(name) = name
                        && cache.get_by_name(name)
                    {
                        continue;
                    }
                    let outcome = self.paint_xobject(
                        name, resources, manager, builder, cache, seen, depth,
                    );
                    self.swallow("XObject", outcome)?;
                }
                TextOp::SetGState => {
                    let outcome =
                        self.set_gstate(args.first(), resources, builder, &mut manager.state);
                    self.swallow("ExtGState", outcome)?;
                }
                TextOp::BeginMarkedContent
                | TextOp::BeginMarkedContentProps
                | TextOp::EndMarkedContent => builder.flush(),
                _ => {}
            }
        }
    }

    /// `TJ`: the strings of the array are shown, a number moves the text by that many thousandths of the font size
    /// (the other way in a vertical font) after the glyphs before it.
    fn show_spaced_text(
        &self,
        array: Option<&Obj>,
        builder: &mut Builder<'_>,
        state: &mut TextState,
    ) -> Result<()> {
        let items: &[Obj] = match array {
            Some(Obj::Array(items)) => items.as_slice(),
            Some(single @ Obj::Str(_)) => std::slice::from_ref(single),
            _ => {
                return Err(PdfError::Unknown("args[0] is not iterable".to_owned()));
            }
        };
        let vertical = state.font_is_vertical();
        let space_factor = (if vertical { 1.0 } else { -1.0 }) * state.font_size / 1000.0;
        let mut buffer: Vec<u8> = Vec::new();
        for item in items {
            match item {
                Obj::Str(bytes) => buffer.extend_from_slice(bytes),
                Obj::Num(spacing) if *spacing != 0.0 => {
                    let chars = if buffer.is_empty() {
                        Chars::Empty
                    } else {
                        Chars::Bytes(&buffer)
                    };
                    builder.build_text_content_item(state, chars, spacing * space_factor)?;
                    buffer.clear();
                }
                _ => {}
            }
        }
        if !buffer.is_empty() {
            builder.build_text_content_item(state, Chars::Bytes(&buffer), 0.0)?;
        }
        Ok(())
    }

    /// `gs`: an `ExtGState` that names a font sets it.
    fn set_gstate(
        &self,
        operand: Option<&Obj>,
        resources: &Arc<Dict>,
        builder: &mut Builder<'_>,
        state: &mut TextState,
    ) -> Result<()> {
        let Some(name) = operand.and_then(Obj::as_name) else {
            return Err(PdfError::Format(
                "GState must be referred to by name.".to_owned(),
            ));
        };
        let Obj::Dict(ext_gstate) = self.xref.get(resources, "ExtGState")? else {
            return Err(PdfError::Format(
                "ExtGState should be a dictionary.".to_owned(),
            ));
        };
        let Obj::Dict(gstate) = self.xref.get(&ext_gstate, name)? else {
            return Err(PdfError::Format("GState should be a dictionary.".to_owned()));
        };
        let font = self.xref.get(&gstate, "Font")?;
        if !truthy(&font) {
            return Ok(());
        }
        builder.flush();
        state.font_name = None;
        let (size, font_arg) = match &font {
            Obj::Array(items) => (number_at(items, 1), items.first()),
            _ => (f64::NAN, None),
        };
        state.font_size = size;
        self.handle_set_font(None, font_arg, resources, state)
    }

    /// `Do`: a form XObject is read with the state it is invoked in (its matrix applied, its own resources when it
    /// has them); an XObject of another kind, or a form that showed nothing, is remembered as empty.
    #[allow(clippy::too_many_arguments)]
    fn paint_xobject(
        &self,
        name: Option<&str>,
        resources: &Arc<Dict>,
        manager: &StateManager,
        builder: &mut Builder<'_>,
        cache: &mut EmptyCache,
        seen: &[String],
        depth: usize,
    ) -> Result<()> {
        let Some(name) = name else {
            return Err(PdfError::Format(
                "XObject must be referred to by name.".to_owned(),
            ));
        };
        let xobjects = match self.xref.get(resources, "XObject")? {
            Obj::Dict(dict) => dict,
            other if truthy(&other) => {
                return Err(PdfError::Unknown(
                    "xobjs.getRaw is not a function".to_owned(),
                ));
            }
            _ => Arc::new(Dict::new()),
        };
        let mut xobject = xobjects.get_raw(name).cloned().unwrap_or(Obj::Null);
        if let Obj::Ref(reference) = xobject {
            if cache.by_ref.contains(&reference.to_string()) {
                return Ok(());
            }
            xobject = self.xref.fetch(reference, false)?;
        }
        let Obj::Stream(stream) = xobject else {
            return Err(PdfError::Format("XObject should be a stream".to_owned()));
        };
        let Obj::Name(subtype) = self.xref.get(&stream.dict, "Subtype")? else {
            return Err(PdfError::Format(
                "XObject should have a Name subtype".to_owned(),
            ));
        };
        if &*subtype != "Form" {
            cache.set(name, stream.dict.obj_id.as_deref());
            return Ok(());
        }
        if depth + 1 > MAX_FORM_DEPTH {
            return Err(PdfError::Format(format!(
                "form XObjects are nested deeper than {MAX_FORM_DEPTH}"
            )));
        }
        let mut form_manager = StateManager::new(manager.state.clone());
        if let Some(matrix) = lookup_matrix(&self.xref.get_array(&stream.dict, "Matrix")?) {
            form_manager.transform(&matrix);
        }
        let form_resources = match self.xref.get(&stream.dict, "Resources")? {
            Obj::Dict(own) => own,
            _ => resources.clone(),
        };
        let content = stream.decode(self.xref.filters().as_ref(), self.xref.guard())?;
        let before = builder.sink.items.len();
        self.get_text_content(
            content,
            stream.dict.obj_id.as_deref(),
            &form_resources,
            form_manager,
            seen,
            &mut *builder.sink,
            depth + 1,
        )?;
        if builder.sink.items.len() == before {
            cache.set(name, stream.dict.obj_id.as_deref());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_xobject_is_remembered_by_reference_and_by_name() {
        let mut cache = EmptyCache::default();
        assert!(!cache.get_by_name("Im1"));
        cache.set("Im1", Some("7R"));
        assert!(cache.get_by_name("Im1"));
        assert!(cache.by_ref.contains("7R"));
        cache.set("Fm0", None);
        assert!(cache.get_by_name("Fm0"));
        assert!(!cache.get_by_name("Fm1"));
    }

    #[test]
    fn a_matrix_is_six_numbers() {
        let six = Obj::Array(Arc::new((1..=6).map(|n| Obj::Num(f64::from(n))).collect()));
        assert_eq!(lookup_matrix(&six), Some([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]));
        let short = Obj::Array(Arc::new(vec![Obj::Num(1.0)]));
        assert_eq!(lookup_matrix(&short), None);
        let mixed = Obj::Array(Arc::new(
            (0..6)
                .map(|n| if n == 2 { Obj::name("x") } else { Obj::Num(1.0) })
                .collect(),
        ));
        assert_eq!(lookup_matrix(&mixed), None);
    }

    #[test]
    fn a_false_or_empty_operand_shows_only_the_spacing() {
        let state = TextState::new();
        assert!(matches!(chars_of(&state, None), Ok(Chars::Empty)));
        assert!(matches!(
            chars_of(&state, Some(&Obj::string(b""))),
            Ok(Chars::Empty)
        ));
        assert!(matches!(
            chars_of(&state, Some(&Obj::Num(0.0))),
            Ok(Chars::Empty)
        ));
        assert!(matches!(
            chars_of(&state, Some(&Obj::string(b"ab"))),
            Ok(Chars::Bytes(b"ab"))
        ));
        assert!(matches!(
            chars_of(&state, Some(&Obj::name("N"))),
            Ok(Chars::NoGlyphs)
        ));
    }
}
