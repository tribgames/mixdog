//! The content-stream interpreter of the operator-list pass: pdf.js's `EvaluatorPreprocessor` (operands collected
//! against the operator table, the argument-count recovery) and `PartialEvaluator.getOperatorList` (what each
//! operator becomes). The evaluator keeps pdf.js's `EvalState`; the events go to an [`OperatorList`].

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use crate::color::{self, ColorSpace};
use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::function;
use crate::lexer::{CommandArgs, KnownCommands, Lexer};
use crate::object::{Dict, Obj};
use crate::parser::Parser;
use crate::stream::{ByteStream, PdfStream};
use crate::xref::Xref;

use super::events::{
    DRAW_CLOSE_PATH, DRAW_CURVE_TO, DRAW_LINE_TO, DRAW_MOVE_TO, Expression, GStateValue, Group, ImageRef, InlineImage, MarkedData, Op, OperatorList,
    OptionalContent, PaintOp, ParamOp, PathData, Pattern, ShadingRef, SoftMask, TextItem, TilingPattern,
};
use super::gstate::{self, BBOX_INIT, EvalState, StateManager};
use super::{FontHandle, FontProvider, LoadedFont, Type3Data, truthy};

/// `EvaluatorPreprocessor.MAX_INVALID_PATH_OPS`.
const MAX_INVALID_PATH_OPS: usize = 10;
/// The most operands one operator takes (`Too many arguments`).
const MAX_ARGS: usize = 33;
/// `SMALL_IMAGE_DIMENSIONS`.
const SMALL_IMAGE_DIMENSIONS: f64 = 200.0;
/// `MAX_LENGTH_TO_CACHE` of the parser's inline image cache.
const MAX_LENGTH_TO_CACHE: usize = 1000;

// ---- the operator table ----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Code {
    SetLineWidth,
    SetLineCap,
    SetLineJoin,
    SetMiterLimit,
    SetDash,
    SetRenderingIntent,
    SetFlatness,
    SetGState,
    Save,
    Restore,
    Transform,
    MoveTo,
    LineTo,
    CurveTo,
    CurveTo2,
    CurveTo3,
    ClosePath,
    Rectangle,
    Stroke,
    CloseStroke,
    Fill,
    EoFill,
    FillStroke,
    EoFillStroke,
    CloseFillStroke,
    CloseEoFillStroke,
    EndPath,
    Clip,
    EoClip,
    BeginText,
    EndText,
    SetCharSpacing,
    SetWordSpacing,
    SetHScale,
    SetLeading,
    SetFont,
    SetTextRenderingMode,
    SetTextRise,
    MoveText,
    SetLeadingMoveText,
    SetTextMatrix,
    NextLine,
    ShowText,
    ShowSpacedText,
    NextLineShowText,
    NextLineSetSpacingShowText,
    SetCharWidth,
    SetCharWidthAndBounds,
    SetStrokeColorSpace,
    SetFillColorSpace,
    SetStrokeColor,
    SetStrokeColorN,
    SetFillColor,
    SetFillColorN,
    SetStrokeGray,
    SetFillGray,
    SetStrokeRgbColor,
    SetFillRgbColor,
    SetStrokeCmykColor,
    SetFillCmykColor,
    ShadingFill,
    EndInlineImage,
    PaintXObject,
    MarkPoint,
    MarkPointProps,
    BeginMarkedContent,
    BeginMarkedContentProps,
    EndMarkedContent,
    BeginCompat,
    EndCompat,
}

/// `EvaluatorPreprocessor.opMap`: the operator, what it is, how many operands, whether fewer are accepted. Entries
/// with no `Code` are the ones pdf.js lists as `null` (they only keep the lexer joining `BMC`, `BDC`, `true`...) and
/// `BI` / `ID`, which the parser consumes.
const OP_MAP: &[(&str, Option<Code>, usize, bool)] = &[
    ("w", Some(Code::SetLineWidth), 1, false),
    ("J", Some(Code::SetLineCap), 1, false),
    ("j", Some(Code::SetLineJoin), 1, false),
    ("M", Some(Code::SetMiterLimit), 1, false),
    ("d", Some(Code::SetDash), 2, false),
    ("ri", Some(Code::SetRenderingIntent), 1, false),
    ("i", Some(Code::SetFlatness), 1, false),
    ("gs", Some(Code::SetGState), 1, false),
    ("q", Some(Code::Save), 0, false),
    ("Q", Some(Code::Restore), 0, false),
    ("cm", Some(Code::Transform), 6, false),
    ("m", Some(Code::MoveTo), 2, false),
    ("l", Some(Code::LineTo), 2, false),
    ("c", Some(Code::CurveTo), 6, false),
    ("v", Some(Code::CurveTo2), 4, false),
    ("y", Some(Code::CurveTo3), 4, false),
    ("h", Some(Code::ClosePath), 0, false),
    ("re", Some(Code::Rectangle), 4, false),
    ("S", Some(Code::Stroke), 0, false),
    ("s", Some(Code::CloseStroke), 0, false),
    ("f", Some(Code::Fill), 0, false),
    ("F", Some(Code::Fill), 0, false),
    ("f*", Some(Code::EoFill), 0, false),
    ("B", Some(Code::FillStroke), 0, false),
    ("B*", Some(Code::EoFillStroke), 0, false),
    ("b", Some(Code::CloseFillStroke), 0, false),
    ("b*", Some(Code::CloseEoFillStroke), 0, false),
    ("n", Some(Code::EndPath), 0, false),
    ("W", Some(Code::Clip), 0, false),
    ("W*", Some(Code::EoClip), 0, false),
    ("BT", Some(Code::BeginText), 0, false),
    ("ET", Some(Code::EndText), 0, false),
    ("Tc", Some(Code::SetCharSpacing), 1, false),
    ("Tw", Some(Code::SetWordSpacing), 1, false),
    ("Tz", Some(Code::SetHScale), 1, false),
    ("TL", Some(Code::SetLeading), 1, false),
    ("Tf", Some(Code::SetFont), 2, false),
    ("Tr", Some(Code::SetTextRenderingMode), 1, false),
    ("Ts", Some(Code::SetTextRise), 1, false),
    ("Td", Some(Code::MoveText), 2, false),
    ("TD", Some(Code::SetLeadingMoveText), 2, false),
    ("Tm", Some(Code::SetTextMatrix), 6, false),
    ("T*", Some(Code::NextLine), 0, false),
    ("Tj", Some(Code::ShowText), 1, false),
    ("TJ", Some(Code::ShowSpacedText), 1, false),
    ("'", Some(Code::NextLineShowText), 1, false),
    ("\"", Some(Code::NextLineSetSpacingShowText), 3, false),
    ("d0", Some(Code::SetCharWidth), 2, false),
    ("d1", Some(Code::SetCharWidthAndBounds), 6, false),
    ("CS", Some(Code::SetStrokeColorSpace), 1, false),
    ("cs", Some(Code::SetFillColorSpace), 1, false),
    ("SC", Some(Code::SetStrokeColor), 4, true),
    ("SCN", Some(Code::SetStrokeColorN), 33, true),
    ("sc", Some(Code::SetFillColor), 4, true),
    ("scn", Some(Code::SetFillColorN), 33, true),
    ("G", Some(Code::SetStrokeGray), 1, false),
    ("g", Some(Code::SetFillGray), 1, false),
    ("RG", Some(Code::SetStrokeRgbColor), 3, false),
    ("rg", Some(Code::SetFillRgbColor), 3, false),
    ("K", Some(Code::SetStrokeCmykColor), 4, false),
    ("k", Some(Code::SetFillCmykColor), 4, false),
    ("sh", Some(Code::ShadingFill), 1, false),
    ("BI", None, 0, false),
    ("ID", None, 0, false),
    ("EI", Some(Code::EndInlineImage), 1, false),
    ("Do", Some(Code::PaintXObject), 1, false),
    ("MP", Some(Code::MarkPoint), 1, false),
    ("DP", Some(Code::MarkPointProps), 2, false),
    ("BMC", Some(Code::BeginMarkedContent), 1, false),
    ("BDC", Some(Code::BeginMarkedContentProps), 2, false),
    ("EMC", Some(Code::EndMarkedContent), 0, false),
    ("BX", Some(Code::BeginCompat), 0, false),
    ("EX", Some(Code::EndCompat), 0, false),
    ("BM", None, 0, false),
    ("BD", None, 0, false),
    ("true", None, 0, false),
    ("fa", None, 0, false),
    ("fal", None, 0, false),
    ("fals", None, 0, false),
    ("false", None, 0, false),
    ("nu", None, 0, false),
    ("nul", None, 0, false),
    ("null", None, 0, false),
];

/// The table the lexer joins commands by and the inline-image end search counts operands with. pdf.js's `null`
/// entries are known to the lexer but name no operator, so the search treats them as unknown: here they get an
/// operand count no operand run reaches.
fn known_commands() -> Arc<KnownCommands> {
    static KNOWN: OnceLock<Arc<KnownCommands>> = OnceLock::new();
    KNOWN
        .get_or_init(|| {
            let mut map = KnownCommands::new();
            for &(name, code, num_args, variable_args) in OP_MAP {
                let entry = if code.is_some() && name != "BI" && name != "ID" {
                    CommandArgs { num_args, variable_args }
                } else if name == "BI" || name == "ID" {
                    CommandArgs { num_args: 0, variable_args: false }
                } else {
                    CommandArgs { num_args: usize::MAX, variable_args: false }
                };
                map.insert(name.to_owned(), entry);
            }
            Arc::new(map)
        })
        .clone()
}

fn spec_of(name: &str) -> Option<(Code, usize, bool)> {
    OP_MAP.iter().find(|(n, ..)| *n == name).and_then(|&(_, code, num_args, variable)| code.map(|c| (c, num_args, variable)))
}

/// `fn >= OPS.moveTo && fn <= OPS.endPath`.
fn is_path_code(code: Code) -> bool {
    matches!(
        code,
        Code::MoveTo
            | Code::LineTo
            | Code::CurveTo
            | Code::CurveTo2
            | Code::CurveTo3
            | Code::ClosePath
            | Code::Rectangle
            | Code::Stroke
            | Code::CloseStroke
            | Code::Fill
            | Code::EoFill
            | Code::FillStroke
            | Code::EoFillStroke
            | Code::CloseFillStroke
            | Code::CloseEoFillStroke
            | Code::EndPath
    )
}

// ---- helpers over objects --------------------------------------------------------------------------------------------

fn format_error(message: impl Into<String>) -> PdfError {
    PdfError::Format(message.into())
}

/// A number operand as JavaScript reads it: anything else is NaN.
fn number_at(args: &[Obj], at: usize) -> f64 {
    args.get(at).and_then(Obj::as_num).unwrap_or(f64::NAN)
}

/// `isNumberArray(args, null)` of an operand run.
fn all_numbers(args: &[Obj]) -> Option<Vec<f64>> {
    if args.is_empty() {
        return None;
    }
    args.iter().map(Obj::as_num).collect()
}

fn is_dict(obj: &Obj) -> bool {
    matches!(obj, Obj::Dict(_))
}

/// `lookupMatrix` / `lookupRect` of an array: all numbers and the right length.
fn number_array(obj: &Obj, len: usize) -> Option<Vec<f64>> {
    let Obj::Array(items) = obj else {
        return None;
    };
    if items.len() != len {
        return None;
    }
    items.iter().map(Obj::as_num).collect()
}

fn f32_array<const N: usize>(values: &[f64]) -> [f32; N] {
    let mut out = [0.0f32; N];
    for (slot, &v) in out.iter_mut().zip(values) {
        *slot = v as f32;
    }
    out
}

/// `isPDFFunction`.
fn is_pdf_function(obj: &Obj) -> bool {
    match obj {
        Obj::Dict(d) => d.has("FunctionType"),
        Obj::Stream(s) => s.dict.has("FunctionType"),
        _ => false,
    }
}

/// `===` between two values read from one array: names, numbers and references compare by value.
fn same_value(a: &Obj, b: &Obj) -> bool {
    match (a, b) {
        (Obj::Name(x), Obj::Name(y)) => x == y,
        (Obj::Num(x), Obj::Num(y)) => x == y,
        (Obj::Ref(x), Obj::Ref(y)) => x == y,
        (Obj::Bool(x), Obj::Bool(y)) => x == y,
        (Obj::Null, Obj::Null) => true,
        (Obj::Dict(x), Obj::Dict(y)) => Arc::ptr_eq(x, y),
        _ => false,
    }
}

/// `normalizeBlendMode`.
fn normalize_blend_mode(value: &Obj, parsing_array: bool) -> Option<&'static str> {
    match value {
        Obj::Array(items) => {
            for item in items.iter() {
                if let Some(mode) = normalize_blend_mode(item, true) {
                    return Some(mode);
                }
            }
            tracing::warn!("Unsupported blend mode Array.");
            Some("source-over")
        }
        Obj::Name(name) => {
            let mode = match &**name {
                "Normal" | "Compatible" => "source-over",
                "Multiply" => "multiply",
                "Screen" => "screen",
                "Overlay" => "overlay",
                "Darken" => "darken",
                "Lighten" => "lighten",
                "ColorDodge" => "color-dodge",
                "ColorBurn" => "color-burn",
                "HardLight" => "hard-light",
                "SoftLight" => "soft-light",
                "Difference" => "difference",
                "Exclusion" => "exclusion",
                "Hue" => "hue",
                "Saturation" => "saturation",
                "Color" => "color",
                "Luminosity" => "luminosity",
                other => {
                    tracing::warn!("Unsupported blend mode: {other}");
                    return if parsing_array { None } else { Some("source-over") };
                }
            };
            Some(mode)
        }
        _ => {
            if parsing_array {
                None
            } else {
                Some("source-over")
            }
        }
    }
}

// ---- the preprocessor ------------------------------------------------------------------------------------------------

struct Preprocessor<'x> {
    parser: Parser<'x>,
    non_processed: Vec<Obj>,
    is_path_op: bool,
    num_invalid_path_ops: usize,
}

impl<'x> Preprocessor<'x> {
    /// `EvaluatorPreprocessor.read`: the next operator with exactly the operands it takes. Operands that do not fit
    /// are carried to the neighbouring operators, an operator with too few is skipped, and a run of ten invalid
    /// path operators is a format error. `q`, `Q` and `cm` update the state manager as they are read.
    fn read(&mut self, sm: &mut StateManager) -> Result<Option<(Code, Vec<Obj>)>> {
        let mut args: Vec<Obj> = Vec::new();
        loop {
            let obj = self.parser.get_obj(None)?;
            match &obj {
                Obj::Cmd(cmd) => {
                    let Some((code, num_args, variable)) = spec_of(cmd) else {
                        tracing::warn!("Unknown command \"{cmd}\".");
                        continue;
                    };
                    let mut args_length = args.len();
                    if !self.is_path_op {
                        self.num_invalid_path_ops = 0;
                    }
                    self.is_path_op = is_path_code(code);
                    if !variable {
                        if args_length != num_args {
                            while args_length > num_args {
                                self.non_processed.push(args.remove(0));
                                args_length -= 1;
                            }
                            while args_length < num_args && !self.non_processed.is_empty() {
                                if let Some(carried) = self.non_processed.pop() {
                                    args.insert(0, carried);
                                }
                                args_length += 1;
                            }
                        }
                        if args_length < num_args {
                            let partial = format!("command {cmd}: expected {num_args} args, but received {args_length} args.");
                            if self.is_path_op {
                                self.num_invalid_path_ops += 1;
                                if self.num_invalid_path_ops > MAX_INVALID_PATH_OPS {
                                    return Err(format_error(format!("Invalid {partial}")));
                                }
                            }
                            tracing::warn!("Skipping {partial}");
                            args.clear();
                            continue;
                        }
                    } else if args_length > num_args {
                        tracing::debug!("Command {cmd}: expected [0, {num_args}] args, but received {args_length} args.");
                    }
                    match code {
                        Code::Save => sm.save(),
                        Code::Restore => sm.restore(),
                        Code::Transform => {
                            let m: Vec<f64> = (0..6).map(|i| number_at(&args, i)).collect();
                            sm.transform(&m);
                        }
                        _ => {}
                    }
                    return Ok(Some((code, args)));
                }
                Obj::Eof => return Ok(None),
                Obj::Null => {}
                _ => {
                    args.push(obj);
                    if args.len() > MAX_ARGS {
                        return Err(format_error("Too many arguments"));
                    }
                }
            }
        }
    }
}

// ---- the evaluator ---------------------------------------------------------------------------------------------------

/// What an image's operators were, kept for the next paint of the same image.
#[derive(Clone)]
struct CachedImage {
    op: Op,
    /// `Some(None)` is optional content that could not be read (it still brackets the image).
    optional_content: Option<Option<OptionalContent>>,
    has_mask: bool,
}

/// What lives as long as one content stream is read: its local image cache, the ids of its small inline images
/// (`Parser.#imageCache`) and its shading ids.
#[derive(Default)]
struct Scope {
    images: HashMap<String, CachedImage>,
    inline_keys: HashMap<String, String>,
    inline_count: usize,
    shadings: HashMap<String, ShadingRef>,
}

/// An `SMask` of an `ExtGState`, as read.
struct SmaskInput {
    subtype: String,
    backdrop: Option<Vec<f64>>,
    transfer_map: Option<Vec<u8>>,
}

pub struct Evaluator<'a> {
    xref: &'a Xref,
    fonts: Option<&'a dyn FontProvider>,
    ignore_errors: bool,
    page_index: usize,
    next_object: usize,
    next_font: usize,
    regional_images: HashMap<String, CachedImage>,
    font_cache: HashMap<String, FontHandle>,
    type3_font_refs: Vec<String>,
    parsing_type3: bool,
    warned_no_fonts: bool,
}

impl<'a> Evaluator<'a> {
    pub fn new(document: &'a Document, fonts: Option<&'a dyn FontProvider>, page_index: usize) -> Self {
        Evaluator {
            xref: document.xref(),
            fonts,
            ignore_errors: document.options().ignore_errors,
            page_index,
            next_object: 0,
            next_font: 0,
            regional_images: HashMap::new(),
            font_cache: HashMap::new(),
            type3_font_refs: Vec::new(),
            parsing_type3: false,
            warned_no_fonts: false,
        }
    }

    fn create_obj_id(&mut self) -> usize {
        self.next_object += 1;
        self.next_object
    }

    /// The fonts the evaluator loaded while it read (`commonObjs`).
    pub fn into_fonts(self) -> Vec<FontHandle> {
        self.font_cache.into_values().collect()
    }

    /// `PartialEvaluator.getOperatorList`: reads `content` and adds what it draws to `op_list`. `stream_id` is the
    /// reference the stream was fetched as (a form met again through itself is an error), `prev_refs` the forms that
    /// are being read around it. With `ignore_errors` a failure in the stream ends the stream and keeps the
    /// operators read so far (with the open `q` and marked content closed); cancellation and budget failures
    /// always propagate.
    pub fn get_operator_list(
        &mut self,
        content: Vec<u8>,
        stream_id: Option<&str>,
        resources: &Arc<Dict>,
        op_list: &mut OperatorList,
        initial_state: Option<EvalState>,
        prev_refs: &[String],
    ) -> Result<()> {
        let mut seen: Vec<String> = prev_refs.to_vec();
        if let Some(id) = stream_id {
            if prev_refs.iter().any(|r| r == id) {
                return Err(format_error(format!("getOperatorList - ignoring circular reference: {id}")));
            }
            seen.push(id.to_owned());
        }
        let xref = self.xref;
        let mut sm = StateManager::new(initial_state.unwrap_or_default());
        let lexer = Lexer::with_known_commands(ByteStream::from_vec(content), xref.guard().clone(), Some(known_commands()));
        let parser = Parser::new(lexer, Some(xref), false, false)?;
        let mut pre = Preprocessor { parser, non_processed: Vec::new(), is_path_op: false, num_invalid_path_ops: 0 };
        let mut scope = Scope::default();
        let mut marked = 0usize;
        let outcome = self.run(&mut pre, &mut sm, resources, op_list, &mut scope, &seen, &mut marked);
        match outcome {
            Ok(()) => {}
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) if self.ignore_errors => {
                tracing::warn!("getOperatorList - ignoring errors during \"OperatorList\" task: \"{e}\".");
            }
            Err(e) => return Err(e),
        }
        for _ in 0..marked {
            op_list.add_op(Op::EndMarkedContent);
        }
        for _ in 0..sm.saved_depth() {
            op_list.add_op(Op::Restore);
        }
        Ok(())
    }

    /// An error of one operator that pdf.js's own `.catch` swallows under `ignoreErrors` and throws otherwise.
    fn swallow(&self, what: &str, outcome: Result<()>) -> Result<()> {
        match outcome {
            Err(e) if e.is_fatal() => Err(e),
            Err(e) if self.ignore_errors => {
                tracing::warn!("getOperatorList - ignoring {what}: \"{e}\".");
                Ok(())
            }
            other => other,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        pre: &mut Preprocessor<'_>,
        sm: &mut StateManager,
        resources: &Arc<Dict>,
        op_list: &mut OperatorList,
        scope: &mut Scope,
        seen: &[String],
        marked: &mut usize,
    ) -> Result<()> {
        let xref = self.xref;
        loop {
            xref.guard().tick()?;
            let Some((code, args)) = pre.read(sm)? else {
                return Ok(());
            };
            match code {
                Code::PaintXObject => {
                    let Some(name) = args.first().and_then(Obj::as_name).map(str::to_owned) else {
                        let outcome = Err(format_error("XObject must be referred to by name."));
                        self.swallow("XObject", outcome)?;
                        continue;
                    };
                    if let Some(cached) = scope.images.get(&name).cloned() {
                        Self::add_cached_image_ops(op_list, cached);
                        continue;
                    }
                    let outcome = self.paint_xobject(&name, resources, op_list, sm, scope, seen);
                    self.swallow("XObject", outcome)?;
                }
                Code::SetFont => {
                    let size = args.get(1).cloned().unwrap_or(Obj::Null);
                    let name = args.first().and_then(Obj::as_name).map(str::to_owned);
                    let font = self.handle_set_font(name.as_deref(), None, resources, &mut sm.state, seen)?;
                    op_list.add_op(Op::SetFont { loaded_name: font.loaded_name.clone(), size });
                }
                Code::EndInlineImage => {
                    let Some(Obj::Stream(image)) = args.first().cloned() else {
                        continue;
                    };
                    let key = Self::inline_cache_key(&image, scope);
                    if let Some(key) = &key
                        && let Some(cached) = scope.images.get(key).cloned()
                    {
                        Self::add_cached_image_ops(op_list, cached);
                        continue;
                    }
                    let outcome = self.build_paint_image_xobject(resources, &image, true, op_list, key.as_deref(), scope);
                    self.swallow("inline image", outcome)?;
                }
                Code::ShowText | Code::ShowSpacedText | Code::NextLineShowText | Code::NextLineSetSpacingShowText => {
                    self.show_text(code, args, &sm.state, op_list)?;
                }
                Code::SetTextRenderingMode => {
                    sm.state.text_rendering_mode = number_at(&args, 0) as i64;
                    Self::add_param(op_list, ParamOp::SetTextRenderingMode, args);
                }
                Code::SetFillColorSpace | Code::SetStrokeColorSpace => {
                    let space = self.color_space_operand(&args[0], resources)?;
                    if code == Code::SetFillColorSpace {
                        sm.state.set_fill_color_space(space);
                    } else {
                        sm.state.set_stroke_color_space(space);
                    }
                }
                Code::SetFillColor | Code::SetStrokeColor => {
                    let Some(values) = all_numbers(&args) else {
                        continue;
                    };
                    let fill = code == Code::SetFillColor;
                    let space = if fill { sm.state.fill_color_space.clone() } else { sm.state.stroke_color_space.clone() };
                    let hex = space.get_rgb_hex(&values, 0)?;
                    op_list.add_op(Self::rgb_op(fill, hex));
                }
                Code::SetFillGray
                | Code::SetStrokeGray
                | Code::SetFillCmykColor
                | Code::SetStrokeCmykColor
                | Code::SetFillRgbColor
                | Code::SetStrokeRgbColor => {
                    let Some(values) = all_numbers(&args) else {
                        continue;
                    };
                    let fill = matches!(code, Code::SetFillGray | Code::SetFillCmykColor | Code::SetFillRgbColor);
                    let space = match code {
                        Code::SetFillGray | Code::SetStrokeGray => ColorSpace::gray(),
                        Code::SetFillCmykColor | Code::SetStrokeCmykColor => ColorSpace::cmyk(),
                        _ => ColorSpace::rgb(),
                    };
                    let hex = space.get_rgb_hex(&values, 0)?;
                    if fill {
                        sm.state.set_fill_color_space(space);
                    } else {
                        sm.state.set_stroke_color_space(space);
                    }
                    op_list.add_op(Self::rgb_op(fill, hex));
                }
                Code::SetFillColorN | Code::SetStrokeColorN => {
                    self.set_color_n(code == Code::SetFillColorN, args, &sm.state, resources, op_list, scope, seen)?;
                }
                Code::ShadingFill => {
                    let outcome = self.shading_operand(&args[0], resources, scope);
                    match outcome {
                        Ok(shading) => op_list.add_op(Op::ShadingFill(shading)),
                        Err(e) if e.is_fatal() => return Err(e),
                        Err(e) if self.ignore_errors => {
                            tracing::warn!("getOperatorList - ignoring Shading: \"{e}\".");
                        }
                        Err(e) => return Err(e),
                    }
                }
                Code::SetGState => {
                    let outcome = self.set_gstate(&args[0], resources, op_list, sm, seen);
                    self.swallow("ExtGState", outcome)?;
                }
                Code::SetLineWidth => {
                    let Some(thickness) = args.first().and_then(Obj::as_num) else {
                        tracing::warn!("Invalid setLineWidth.");
                        continue;
                    };
                    op_list.add_op(Op::SetLineWidth(thickness.abs()));
                }
                Code::SetDash => {
                    let Some(phase) = args.get(1).and_then(Obj::as_num) else {
                        tracing::warn!("Invalid setDash.");
                        continue;
                    };
                    let Some(Obj::Array(array)) = args.first() else {
                        tracing::warn!("Invalid setDash.");
                        continue;
                    };
                    let numbers: Vec<f64> = array.iter().filter_map(Obj::as_num).collect();
                    op_list.add_op(Op::SetDash { array: numbers, phase });
                }
                Code::MoveTo | Code::LineTo | Code::CurveTo | Code::CurveTo2 | Code::CurveTo3 | Code::ClosePath | Code::Rectangle => {
                    Self::build_path(code, &args, &mut sm.state)
                }
                Code::Stroke
                | Code::CloseStroke
                | Code::Fill
                | Code::EoFill
                | Code::FillStroke
                | Code::EoFillStroke
                | Code::CloseFillStroke
                | Code::CloseEoFillStroke
                | Code::EndPath => Self::paint_path(code, &mut sm.state, op_list),
                Code::SetTextMatrix => {
                    let values: Vec<f64> = (0..6).map(|i| number_at(&args, i)).collect();
                    op_list.add_op(Op::SetTextMatrix(f32_array::<6>(&values)));
                }
                Code::MarkPoint | Code::MarkPointProps | Code::BeginCompat | Code::EndCompat => {}
                Code::BeginMarkedContentProps => {
                    *marked += 1;
                    self.begin_marked_content_props(&args, resources, op_list)?;
                }
                Code::BeginMarkedContent => {
                    if args.iter().any(is_dict) {
                        tracing::warn!("getOperatorList - ignoring operator: BMC");
                        continue;
                    }
                    *marked += 1;
                    let tag = args.first().and_then(Obj::as_name).map(str::to_owned);
                    op_list.add_op(Op::BeginMarkedContent(tag));
                }
                Code::EndMarkedContent => {
                    if args.iter().any(is_dict) {
                        tracing::warn!("getOperatorList - ignoring operator: EMC");
                        continue;
                    }
                    if *marked == 0 {
                        continue;
                    }
                    *marked -= 1;
                    op_list.add_op(Op::EndMarkedContent);
                }
                Code::Save => op_list.add_op(Op::Save),
                Code::Restore => op_list.add_op(Op::Restore),
                Code::Transform => {
                    let m: Vec<f64> = (0..6).map(|i| number_at(&args, i)).collect();
                    op_list.add_op(Op::Transform(f64_array6(&m)));
                }
                Code::Clip | Code::EoClip | Code::BeginText | Code::EndText => {
                    if args.iter().any(is_dict) {
                        tracing::warn!("getOperatorList - ignoring operator.");
                        continue;
                    }
                    op_list.add_op(match code {
                        Code::Clip => Op::Clip,
                        Code::EoClip => Op::EoClip,
                        Code::BeginText => Op::BeginText,
                        _ => Op::EndText,
                    });
                }
                Code::SetLineCap => Self::add_param(op_list, ParamOp::SetLineCap, args),
                Code::SetLineJoin => Self::add_param(op_list, ParamOp::SetLineJoin, args),
                Code::SetMiterLimit => Self::add_param(op_list, ParamOp::SetMiterLimit, args),
                Code::SetRenderingIntent => {
                    Self::add_param(op_list, ParamOp::SetRenderingIntent, args);
                }
                Code::SetFlatness => Self::add_param(op_list, ParamOp::SetFlatness, args),
                Code::SetCharSpacing => Self::add_param(op_list, ParamOp::SetCharSpacing, args),
                Code::SetWordSpacing => Self::add_param(op_list, ParamOp::SetWordSpacing, args),
                Code::SetHScale => Self::add_param(op_list, ParamOp::SetHScale, args),
                Code::SetLeading => Self::add_param(op_list, ParamOp::SetLeading, args),
                Code::SetTextRise => Self::add_param(op_list, ParamOp::SetTextRise, args),
                Code::MoveText => Self::add_param(op_list, ParamOp::MoveText, args),
                Code::SetLeadingMoveText => {
                    Self::add_param(op_list, ParamOp::SetLeadingMoveText, args);
                }
                Code::NextLine => Self::add_param(op_list, ParamOp::NextLine, args),
                Code::SetCharWidth => Self::add_param(op_list, ParamOp::SetCharWidth, args),
                Code::SetCharWidthAndBounds => {
                    Self::add_param(op_list, ParamOp::SetCharWidthAndBounds, args);
                }
            }
        }
    }

    fn add_param(op_list: &mut OperatorList, op: ParamOp, args: Vec<Obj>) {
        if args.iter().any(is_dict) {
            tracing::warn!("getOperatorList - ignoring operator: {op:?}");
            return;
        }
        op_list.add_op(Op::Param(op, args));
    }

    fn rgb_op(fill: bool, hex: String) -> Op {
        if fill { Op::SetFillRgbColor(hex) } else { Op::SetStrokeRgbColor(hex) }
    }

    #[allow(clippy::too_many_arguments)]
    fn set_color_n(
        &mut self,
        fill: bool,
        args: Vec<Obj>,
        state: &EvalState,
        resources: &Arc<Dict>,
        op_list: &mut OperatorList,
        scope: &mut Scope,
        seen: &[String],
    ) -> Result<()> {
        let current = if fill { state.pattern_fill_color_space.clone() } else { state.pattern_stroke_color_space.clone() };
        let Some(space) = current else {
            if let Some(values) = all_numbers(&args) {
                let hex = ColorSpace::gray().get_rgb_hex(&values, 0)?;
                op_list.add_op(Self::rgb_op(fill, hex));
            } else {
                op_list.add_op(if fill { Op::SetFillTransparent } else { Op::SetStrokeTransparent });
            }
            return Ok(());
        };
        if space.name() == "Pattern" {
            if args.is_empty() {
                return Ok(());
            }
            return self.handle_color_n(fill, args, &space, resources, op_list, scope, seen);
        }
        let Some(values) = all_numbers(&args) else {
            return Ok(());
        };
        let hex = space.get_rgb_hex(&values, 0)?;
        op_list.add_op(Self::rgb_op(fill, hex));
        Ok(())
    }

    fn paint_path(code: Code, state: &mut EvalState, op_list: &mut OperatorList) {
        if matches!(code, Code::CloseStroke | Code::CloseFillStroke | Code::CloseEoFillStroke) {
            state.path_buffer.push(f64::from(DRAW_CLOSE_PATH));
        }
        let paint = match code {
            Code::Stroke => PaintOp::Stroke,
            Code::CloseStroke => PaintOp::CloseStroke,
            Code::Fill => PaintOp::Fill,
            Code::EoFill => PaintOp::EoFill,
            Code::FillStroke => PaintOp::FillStroke,
            Code::EoFillStroke => PaintOp::EoFillStroke,
            Code::CloseFillStroke => PaintOp::CloseFillStroke,
            Code::CloseEoFillStroke => PaintOp::CloseEoFillStroke,
            _ => PaintOp::EndPath,
        };
        if state.path_buffer.is_empty() {
            op_list.add_op(Op::ConstructPath { paint, path: None });
        } else {
            let data: Vec<f32> = state.path_buffer.iter().map(|&v| v as f32).collect();
            let min_max = state.path_min_max;
            state.path_buffer.clear();
            state.path_min_max = BBOX_INIT;
            op_list.add_op(Op::ConstructPath { paint, path: Some(PathData { data, min_max }) });
        }
    }

    fn begin_marked_content_props(&self, args: &[Obj], resources: &Arc<Dict>, op_list: &mut OperatorList) -> Result<()> {
        let Some(tag) = args.first().and_then(Obj::as_name).map(str::to_owned) else {
            tracing::warn!("Expected name for beginMarkedContentProps arg0.");
            op_list.add_op(Op::BeginMarkedContentProps { tag: "OC".to_owned(), data: MarkedData::OptionalContent(None) });
            return Ok(());
        };
        if tag == "OC" {
            let props = args.get(1).cloned().unwrap_or(Obj::Null);
            match self.parse_marked_content_props(&props, resources) {
                Ok(data) => op_list.add_op(Op::BeginMarkedContentProps { tag, data: MarkedData::OptionalContent(data) }),
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) if self.ignore_errors => {
                    tracing::warn!("getOperatorList - ignoring beginMarkedContentProps: \"{e}\".");
                    op_list.add_op(Op::BeginMarkedContentProps { tag, data: MarkedData::OptionalContent(None) });
                }
                Err(e) => return Err(e),
            }
            return Ok(());
        }
        let mcid = match args.get(1) {
            Some(Obj::Dict(dict)) => self.xref.get(dict, "MCID")?,
            _ => Obj::Null,
        };
        op_list.add_op(Op::BeginMarkedContentProps { tag, data: MarkedData::Mcid(mcid) });
        Ok(())
    }

    fn show_text(&self, code: Code, mut args: Vec<Obj>, state: &EvalState, op_list: &mut OperatorList) -> Result<()> {
        if state.font.is_none() {
            return self.ensure_state_font();
        }
        if matches!(code, Code::NextLineShowText | Code::NextLineSetSpacingShowText) {
            op_list.add_op(Op::Param(ParamOp::NextLine, Vec::new()));
        }
        if code == Code::NextLineSetSpacingShowText {
            let word = args.remove(0);
            op_list.add_op(Op::Param(ParamOp::SetWordSpacing, vec![word]));
            let character = args.remove(0);
            op_list.add_op(Op::Param(ParamOp::SetCharSpacing, vec![character]));
        }
        let items = if code == Code::ShowSpacedText {
            let mut items = Vec::new();
            if let Some(Obj::Array(array)) = args.first() {
                for item in array.iter() {
                    match item {
                        Obj::Str(_) => items.extend(self.handle_text(Some(item), state).into_iter().map(TextItem::Glyph)),
                        Obj::Num(n) => items.push(TextItem::Adjust(*n)),
                        _ => {}
                    }
                }
            }
            items
        } else {
            self.handle_text(args.first(), state).into_iter().map(TextItem::Glyph).collect()
        };
        op_list.add_op(Op::ShowText(items));
        Ok(())
    }

    // ---- colour spaces -------------------------------------------------------------------------------------------

    /// `_getColorSpace` and `_handleColorSpace` of `cs` / `CS`: a colour space that cannot be built is DeviceGray
    /// under `ignoreErrors` (with a warning) and an error otherwise.
    fn color_space_operand(&self, operand: &Obj, resources: &Dict) -> Result<Arc<ColorSpace>> {
        match color::parse(operand, self.xref, Some(resources)) {
            Ok(space) => Ok(space),
            Err(e) if e.is_fatal() => Err(e),
            Err(e) if self.ignore_errors => {
                tracing::warn!("_handleColorSpace - ignoring ColorSpace: \"{e}\".");
                Ok(ColorSpace::gray())
            }
            Err(e) => Err(e),
        }
    }

    // ---- paths ---------------------------------------------------------------------------------------------------

    /// `buildPath`: the operator's segment goes to the path buffer (as doubles, the buffer is single precision
    /// only when it is emitted) and its box joins the path's.
    fn build_path(code: Code, args: &[Obj], state: &mut EvalState) {
        let n = |i: usize| number_at(args, i);
        let buffer = &mut state.path_buffer;
        let min_max = &mut state.path_min_max;
        let (mv, ln, cv, cl) = (f64::from(DRAW_MOVE_TO), f64::from(DRAW_LINE_TO), f64::from(DRAW_CURVE_TO), f64::from(DRAW_CLOSE_PATH));
        match code {
            Code::Rectangle => {
                let (x, y, width, height) = (n(0), n(1), n(2), n(3));
                state.current_point = (x, y);
                let (xw, yh) = (x + width, y + height);
                if width == 0.0 || height == 0.0 {
                    buffer.extend_from_slice(&[mv, x, y, ln, xw, yh, cl]);
                } else {
                    buffer.extend_from_slice(&[mv, x, y, ln, xw, y, ln, xw, yh, ln, x, yh, cl]);
                }
                gstate::rect_bounding_box(x, y, xw, yh, min_max);
            }
            Code::MoveTo => {
                let (x, y) = (n(0), n(1));
                state.current_point = (x, y);
                buffer.extend_from_slice(&[mv, x, y]);
                gstate::point_bounding_box(x, y, min_max);
            }
            Code::LineTo => {
                let (x, y) = (n(0), n(1));
                state.current_point = (x, y);
                buffer.extend_from_slice(&[ln, x, y]);
                gstate::point_bounding_box(x, y, min_max);
            }
            Code::CurveTo => {
                let (sx, sy) = state.current_point;
                let (x1, y1, x2, y2, x, y) = (n(0), n(1), n(2), n(3), n(4), n(5));
                state.current_point = (x, y);
                buffer.extend_from_slice(&[cv, x1, y1, x2, y2, x, y]);
                gstate::bezier_bounding_box(sx, sy, x1, y1, x2, y2, x, y, min_max);
            }
            Code::CurveTo2 => {
                let (sx, sy) = state.current_point;
                let (x1, y1, x, y) = (n(0), n(1), n(2), n(3));
                state.current_point = (x, y);
                buffer.extend_from_slice(&[cv, sx, sy, x1, y1, x, y]);
                gstate::bezier_bounding_box(sx, sy, sx, sy, x1, y1, x, y, min_max);
            }
            Code::CurveTo3 => {
                let (sx, sy) = state.current_point;
                let (x1, y1, x, y) = (n(0), n(1), n(2), n(3));
                state.current_point = (x, y);
                buffer.extend_from_slice(&[cv, x1, y1, x, y, x, y]);
                gstate::bezier_bounding_box(sx, sy, x1, y1, x, y, x, y, min_max);
            }
            _ => buffer.push(cl),
        }
    }

    // ---- XObjects, forms and images ------------------------------------------------------------------------------

    fn stream_bytes(&self, stream: &PdfStream) -> Result<Vec<u8>> {
        match stream.decode(self.xref.filters().as_ref(), self.xref.guard()) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.is_fatal() => Err(e),
            Err(e) if self.ignore_errors => {
                tracing::warn!("getOperatorList - ignoring stream: \"{e}\".");
                Ok(Vec::new())
            }
            Err(e) => Err(e),
        }
    }

    fn paint_xobject(
        &mut self,
        name: &str,
        resources: &Arc<Dict>,
        op_list: &mut OperatorList,
        sm: &mut StateManager,
        scope: &mut Scope,
        seen: &[String],
    ) -> Result<()> {
        let xobjs = match self.xref.get(resources, "XObject")? {
            Obj::Dict(d) => d,
            _ => Arc::new(Dict::new()),
        };
        let mut xobj = xobjs.get_raw(name).cloned().unwrap_or(Obj::Null);
        if let Obj::Ref(reference) = &xobj {
            if let Some(cached) = self.regional_images.get(&reference.to_string()).cloned() {
                Self::add_cached_image_ops(op_list, cached);
                return Ok(());
            }
            xobj = self.xref.fetch(*reference, false)?;
        }
        let Obj::Stream(stream) = xobj else {
            return Err(format_error("XObject should be a stream"));
        };
        let Obj::Name(subtype) = self.xref.get(&stream.dict, "Subtype")? else {
            return Err(format_error("XObject should have a Name subtype"));
        };
        match &*subtype {
            "Form" => {
                sm.save();
                let initial = sm.state.cloned(true);
                self.build_form_xobject(resources, &stream, None, op_list, initial, seen)?;
                sm.restore();
                Ok(())
            }
            "Image" => self.build_paint_image_xobject(resources, &stream, false, op_list, Some(name), scope),
            "PS" => {
                tracing::debug!("Ignored XObject subtype PS");
                Ok(())
            }
            other => Err(format_error(format!("Unhandled XObject subtype {other}"))),
        }
    }

    /// `buildFormXObject`.
    fn build_form_xobject(
        &mut self,
        resources: &Arc<Dict>,
        xobj: &Arc<PdfStream>,
        smask: Option<SmaskInput>,
        op_list: &mut OperatorList,
        initial_state: EvalState,
        seen: &[String],
    ) -> Result<()> {
        let xref = self.xref;
        let dict = &xobj.dict;
        let matrix = number_array(&xref.get_array(dict, "Matrix")?, 6);
        let bbox = number_array(&xref.get_array(dict, "BBox")?, 4).map(|b| gstate::normalize_rect([b[0], b[1], b[2], b[3]]));
        let mut f32_bbox: Option<[f32; 4]> = bbox.map(|b| f32_array::<4>(&b));
        if f32_bbox.is_some_and(|b| b.iter().any(|x| !x.is_finite())) {
            f32_bbox = None;
        }
        let optional_content = if dict.has("OC") {
            let oc = xref.get(dict, "OC")?;
            Some(self.parse_marked_content_props(&oc, resources)?)
        } else {
            None
        };
        if let Some(oc) = &optional_content {
            op_list.add_op(Op::BeginMarkedContentProps { tag: "OC".to_owned(), data: MarkedData::OptionalContent(oc.clone()) });
        }
        let group = match xref.get(dict, "Group")? {
            Obj::Dict(g) => Some(g),
            _ => None,
        };
        let f32_matrix = matrix.as_ref().map(|m| f32_array::<6>(m));
        let begin_bbox = if group.is_some() { None } else { f32_bbox };
        let local_resources = match xref.get(dict, "Resources")? {
            Obj::Dict(d) => d,
            _ => resources.clone(),
        };
        let content = self.stream_bytes(xobj)?;
        let stream_id = dict.obj_id.clone();
        let Some(group) = group else {
            op_list.add_op(Op::FormBegin { matrix: f32_matrix, bbox: begin_bbox });
            self.get_operator_list(content, stream_id.as_deref(), &local_resources, op_list, Some(initial_state), seen)?;
            op_list.add_op(Op::FormEnd);
            if optional_content.is_some() {
                op_list.add_op(Op::EndMarkedContent);
            }
            return Ok(());
        };
        // A transparency group: its content is gathered first, then wrapped.
        let mut isolated = false;
        let mut knockout = false;
        let mut color_space: Option<Arc<ColorSpace>> = None;
        if matches!(xref.get(&group, "S")?, Obj::Name(ref s) if &**s == "Transparency") {
            isolated = truthy(&xref.get(&group, "I")?);
            knockout = truthy(&xref.get(&group, "K")?);
            if group.has("CS") {
                let raw = group.get_raw("CS").cloned().unwrap_or(Obj::Null);
                color_space = Some(self.color_space_operand(&raw, resources)?);
            }
        }
        let is_gray = color_space.as_ref().is_some_and(|c| c.num_comps() == 1);
        let mut soft_mask: Option<SoftMask> = None;
        if let Some(input) = smask {
            let backdrop = match &input.backdrop {
                Some(values) => {
                    let space = color_space.clone().unwrap_or_else(ColorSpace::rgb);
                    Some(space.get_rgb_hex(values, 0)?)
                }
                None if input.subtype == "Luminosity" => Some("#000000".to_owned()),
                None => None,
            };
            soft_mask = Some(SoftMask { subtype: input.subtype, backdrop, transfer_map: input.transfer_map });
        }
        let mut inner = OperatorList::new();
        self.get_operator_list(content, stream_id.as_deref(), &local_resources, &mut inner, Some(initial_state), seen)?;
        let (needs_isolation, has_soft_mask) = isolation_of(inner.ops());
        let has_smask = soft_mask.is_some();
        let options = Group {
            matrix: matrix.as_ref().map(|m| f64_array6(m)),
            bbox: f32_bbox,
            smask: soft_mask,
            isolated,
            knockout,
            needs_isolation: needs_isolation || has_smask,
            has_soft_mask: has_soft_mask || has_smask,
            is_gray,
        };
        op_list.add_op(Op::BeginGroup(options.clone()));
        op_list.add_op(Op::FormBegin { matrix: f32_matrix, bbox: begin_bbox });
        op_list.add_op_list(inner);
        op_list.add_op(Op::FormEnd);
        op_list.add_op(Op::EndGroup(options));
        if optional_content.is_some() {
            op_list.add_op(Op::EndMarkedContent);
        }
        Ok(())
    }

    fn add_cached_image_ops(op_list: &mut OperatorList, cached: CachedImage) {
        Self::add_image_ops(op_list, cached.op, cached.optional_content, cached.has_mask);
    }

    /// `addImageOps`.
    fn add_image_ops(op_list: &mut OperatorList, op: Op, optional_content: Option<Option<OptionalContent>>, has_mask: bool) {
        if has_mask {
            op_list.add_op(Op::Save);
            op_list.add_op(Op::SetGState(vec![("SMask".to_owned(), GStateValue::Bool(false))]));
        }
        if let Some(oc) = &optional_content {
            op_list.add_op(Op::BeginMarkedContentProps { tag: "OC".to_owned(), data: MarkedData::OptionalContent(oc.clone()) });
        }
        op_list.add_op(op);
        if optional_content.is_some() {
            op_list.add_op(Op::EndMarkedContent);
        }
        if has_mask {
            op_list.add_op(Op::Restore);
        }
    }

    /// The parser's inline image cache key: a short image shares its cache name with an identical one met before
    /// in the same content stream (`inline_img_N`, the `cacheKey` the parser gives a cached image). `None` for an
    /// image too long to be cached or without a dictionary.
    fn inline_cache_key(image: &PdfStream, scope: &mut Scope) -> Option<String> {
        let raw = image.raw();
        if raw.len() >= MAX_LENGTH_TO_CACHE || image.dict.is_empty() {
            return None;
        }
        let mut identity = String::new();
        for (key, value) in image.dict.iter() {
            identity.push_str(&format!("{key}={value:?};"));
        }
        identity.push_str(&format!("{raw:?}"));
        if let Some(name) = scope.inline_keys.get(&identity) {
            return Some(name.clone());
        }
        scope.inline_count += 1;
        let name = format!("inline_img_{}", scope.inline_count);
        scope.inline_keys.insert(identity, name.clone());
        Some(name)
    }

    /// `buildPaintImageXObject`: the image becomes one `paintImageXObject` (or a mask, or a small inline image)
    /// with the optional content and soft-mask brackets. The pixels are not decoded here: the operator carries the
    /// stream, and the id the display layer keys the image by (one per image, shared by every paint of it).
    fn build_paint_image_xobject(
        &mut self,
        resources: &Arc<Dict>,
        image: &Arc<PdfStream>,
        is_inline: bool,
        op_list: &mut OperatorList,
        cache_key: Option<&str>,
        scope: &mut Scope,
    ) -> Result<()> {
        let xref = self.xref;
        let dict = &image.dict;
        let image_ref = dict.obj_id.clone();
        let w = xref.get2(dict, "W", "Width")?.as_num().filter(|w| *w != 0.0 && !w.is_nan());
        let h = xref.get2(dict, "H", "Height")?.as_num().filter(|h| *h != 0.0 && !h.is_nan());
        let (Some(w), Some(h)) = (w, h) else {
            tracing::warn!("Image dimensions are missing, or not numbers.");
            return Ok(());
        };
        let optional_content = if dict.has("OC") {
            let oc = xref.get(dict, "OC")?;
            Some(self.parse_marked_content_props(&oc, resources)?)
        } else {
            None
        };
        let image_mask = truthy(&xref.get2(dict, "IM", "ImageMask")?);
        let (op, has_mask) = if image_mask {
            // A one-pixel mask that paints is a solid fill of the colour (`isSingleOpaquePixel`).
            let mut single_opaque_pixel = false;
            if w == 1.0 && h == 1.0 {
                let decode = if dict.has("D") { xref.get_array(dict, "D")? } else { xref.get_array(dict, "Decode")? };
                let inverse_decode = matches!(&decode, Obj::Array(values)
                    if values.first().and_then(Obj::as_num).is_some_and(|d| d > 0.0));
                let bytes = self.stream_bytes(image)?;
                single_opaque_pixel = inverse_decode == (bytes.is_empty() || bytes[0] & 128 != 0);
            }
            if single_opaque_pixel {
                (Op::PaintSolidColorImageMask, false)
            } else {
                let object_id = self.create_obj_id();
                let id = format!("mask_p{}_{}", self.page_index, object_id);
                let reference = ImageRef { id, width: w, height: h, source: image.clone() };
                (Op::PaintImageMask(reference), false)
            }
        } else {
            let has_mask = dict.has("SMask") || dict.has("Mask");
            if is_inline && w + h < SMALL_IMAGE_DIMENSIONS && !has_mask {
                let decoded = Arc::new(crate::image::decode_small_inline_image(xref, Some(resources), image)?);
                let op = Op::PaintInlineImage(InlineImage { width: w, height: h, source: image.clone(), decoded });
                Self::add_image_ops(op_list, op, optional_content, false);
                return Ok(());
            }
            let object_id = self.create_obj_id();
            let id = format!("img_p{}_{}", self.page_index, object_id);
            let reference = ImageRef { id, width: w, height: h, source: image.clone() };
            (Op::PaintImage(reference), has_mask)
        };
        Self::add_image_ops(op_list, op.clone(), optional_content.clone(), has_mask);
        if let Some(key) = cache_key {
            let cached = CachedImage { op, optional_content, has_mask };
            scope.images.insert(key.to_owned(), cached.clone());
            if let Some(reference) = image_ref {
                self.regional_images.insert(reference, cached);
            }
        }
        Ok(())
    }

    // ---- optional content ----------------------------------------------------------------------------------------

    /// `parseMarkedContentProps`.
    fn parse_marked_content_props(&self, props: &Obj, resources: &Dict) -> Result<Option<OptionalContent>> {
        let xref = self.xref;
        let optional: Arc<Dict> = match props {
            Obj::Name(name) => {
                let Obj::Dict(properties) = xref.get(resources, "Properties")? else {
                    return Err(format_error("Cannot read properties of undefined"));
                };
                match xref.get(&properties, name)? {
                    Obj::Dict(d) => d,
                    _ => return Err(format_error("Cannot read properties of undefined")),
                }
            }
            Obj::Dict(d) => d.clone(),
            _ => return Err(format_error("Optional content properties malformed.")),
        };
        let kind = match xref.get(&optional, "Type")? {
            Obj::Name(n) => Some(n.to_string()),
            _ => None,
        };
        match kind.as_deref() {
            Some("OCG") => Ok(Some(OptionalContent::Group { id: optional.obj_id.clone() })),
            Some("OCMD") => {
                if let Obj::Array(expression) = xref.get(&optional, "VE")? {
                    let mut result = Vec::new();
                    self.parse_visibility_expression(&expression, 0, &mut result)?;
                    if !result.is_empty() {
                        return Ok(Some(OptionalContent::Membership { ids: Vec::new(), policy: None, expression: Some(result) }));
                    }
                }
                let groups = xref.get(&optional, "OCGs")?;
                let ids = match &groups {
                    Obj::Array(items) => items
                        .iter()
                        .map(|g| match g {
                            Obj::Ref(r) => r.to_string(),
                            _ => "[object Object]".to_owned(),
                        })
                        .collect::<Vec<_>>(),
                    Obj::Dict(d) => vec![d.obj_id.clone().unwrap_or_default()],
                    _ => return Ok(None),
                };
                let policy = match xref.get(&optional, "P")? {
                    Obj::Name(n) => Some(n.to_string()),
                    _ => None,
                };
                Ok(Some(OptionalContent::Membership { ids, policy, expression: None }))
            }
            _ => Ok(None),
        }
    }

    /// `_parseVisibilityExpression`.
    fn parse_visibility_expression(&self, array: &[Obj], nesting: usize, result: &mut Vec<Expression>) -> Result<()> {
        const MAX_NESTING: usize = 10;
        let nesting = nesting + 1;
        if nesting > MAX_NESTING {
            tracing::warn!("Visibility expression is too deeply nested");
            return Ok(());
        }
        let operator = match array.first() {
            Some(first) => self.xref.fetch_if_ref(first, false)?,
            None => Obj::Null,
        };
        let Obj::Name(operator) = operator else {
            tracing::warn!("Invalid visibility expression");
            return Ok(());
        };
        if array.len() < 2 {
            tracing::warn!("Invalid visibility expression");
            return Ok(());
        }
        match &*operator {
            "And" | "Or" | "Not" => result.push(Expression::Operator(operator.to_string())),
            other => {
                tracing::warn!("Invalid operator {other} in visibility expression");
                return Ok(());
            }
        }
        for raw in &array[1..] {
            let object = self.xref.fetch_if_ref(raw, false)?;
            if let Obj::Array(nested) = &object {
                let mut inner = Vec::new();
                self.parse_visibility_expression(nested, nesting, &mut inner)?;
                result.push(Expression::Nested(inner));
            } else if let Obj::Ref(reference) = raw {
                result.push(Expression::Reference(reference.to_string()));
            }
        }
        Ok(())
    }

    // ---- ExtGState -----------------------------------------------------------------------------------------------

    /// `setGState`: the dictionary's entries become one `setGState`; a font entry loads its font, a soft mask adds
    /// its group before the operator, as pdf.js orders them.
    fn set_gstate(&mut self, name: &Obj, resources: &Arc<Dict>, op_list: &mut OperatorList, sm: &mut StateManager, seen: &[String]) -> Result<()> {
        let xref = self.xref;
        let Obj::Name(name) = name else {
            return Err(format_error("GState must be referred to by name."));
        };
        let Obj::Dict(ext) = xref.get(resources, "ExtGState")? else {
            return Err(format_error("ExtGState should be a dictionary."));
        };
        let Obj::Dict(gstate) = xref.get(&ext, name)? else {
            return Err(format_error("GState should be a dictionary."));
        };
        enum Deferred {
            Font(Obj),
            SMask(Arc<Dict>),
        }
        let mut entries: Vec<(String, GStateValue)> = Vec::new();
        let mut deferred: Vec<Deferred> = Vec::new();
        for key in gstate.keys().map(str::to_owned).collect::<Vec<_>>() {
            let value = xref.get(&gstate, &key)?;
            match key.as_str() {
                "Type" => {}
                "LW" => match value.as_num() {
                    Some(n) => entries.push((key, GStateValue::Number(n.abs()))),
                    None => tracing::warn!("Invalid LW (line width)"),
                },
                "LC" | "LJ" | "ML" | "D" | "RI" | "FL" | "CA" | "ca" => {
                    entries.push((key, GStateValue::Value(value)));
                }
                "Font" => deferred.push(Deferred::Font(value)),
                "BM" => {
                    let mode = normalize_blend_mode(&value, false).unwrap_or("source-over");
                    entries.push((key, GStateValue::BlendMode(mode)));
                }
                "SMask" => match &value {
                    Obj::Name(n) if &**n == "None" => {
                        entries.push((key, GStateValue::Bool(false)));
                    }
                    Obj::Dict(d) => {
                        deferred.push(Deferred::SMask(d.clone()));
                        entries.push((key, GStateValue::Bool(true)));
                    }
                    _ => tracing::warn!("Unsupported SMask type"),
                },
                "TR" | "TR2" => {
                    if key == "TR" && gstate.has("TR2") {
                        continue;
                    }
                    let maps = self.handle_transfer_function(&value)?;
                    entries.push(("TR".to_owned(), GStateValue::Transfer(maps)));
                }
                _ => {}
            }
        }
        for item in deferred {
            match item {
                Deferred::Font(value) => {
                    let (font_obj, size) = match &value {
                        Obj::Array(items) => (items.first().cloned().unwrap_or(Obj::Null), items.get(1).cloned().unwrap_or(Obj::Null)),
                        _ => (Obj::Null, Obj::Null),
                    };
                    let font = self.handle_set_font(None, Some(&font_obj), resources, &mut sm.state, seen)?;
                    entries.push(("Font".to_owned(), GStateValue::Font { loaded_name: font.loaded_name.clone(), size }));
                }
                Deferred::SMask(smask) => {
                    self.handle_smask(&smask, resources, op_list, sm, seen)?;
                }
            }
        }
        if !entries.is_empty() {
            op_list.add_op(Op::SetGState(entries));
        }
        Ok(())
    }

    /// `handleSMask`.
    fn handle_smask(&mut self, smask: &Arc<Dict>, resources: &Arc<Dict>, op_list: &mut OperatorList, sm: &mut StateManager, seen: &[String]) -> Result<()> {
        let xref = self.xref;
        let Obj::Stream(content) = xref.get(smask, "G")? else {
            return Err(format_error("SMask /G should be a stream."));
        };
        let Obj::Name(subtype) = xref.get(smask, "S")? else {
            return Err(format_error("Cannot read properties of undefined (reading 'name')"));
        };
        let backdrop = match xref.get(smask, "BC")? {
            Obj::Array(items) => Some(items.iter().map(|o| o.as_num().unwrap_or(f64::NAN)).collect()),
            _ => None,
        };
        let transfer = xref.get(smask, "TR")?;
        let transfer_map = if is_pdf_function(&transfer) { Some(self.create_transfer_map(&transfer)?) } else { None };
        let input = SmaskInput { subtype: subtype.to_string(), backdrop, transfer_map };
        let initial = sm.state.cloned(true);
        self.build_form_xobject(resources, &content, Some(input), op_list, initial, seen)
    }

    /// `#createTransferMap`: the function sampled at the 256 byte values.
    fn create_transfer_map(&self, function_obj: &Obj) -> Result<Vec<u8>> {
        let transfer = function::create(self.xref, function_obj, false)?;
        let mut map = Vec::with_capacity(256);
        for i in 0..256u32 {
            let input = f64::from((f64::from(i) / 255.0) as f32);
            let mut output = [0.0f64; 1];
            transfer.call(&[input], &mut output)?;
            let y = f64::from(output[0] as f32);
            map.push((y * 255.0) as i64 as i32 as u8);
        }
        Ok(map)
    }

    /// `handleTransferFunction`.
    fn handle_transfer_function(&self, tr: &Obj) -> Result<Option<Vec<Option<Vec<u8>>>>> {
        let entries: Vec<Obj> = match tr {
            Obj::Array(items) => {
                if items.len() > 1 && items.iter().all(|m| same_value(m, &items[0])) {
                    vec![items[0].clone()]
                } else {
                    items.to_vec()
                }
            }
            other if is_pdf_function(other) => vec![other.clone()],
            _ => return Ok(None),
        };
        let mut maps = Vec::new();
        let mut functions = 0;
        let mut effectful = 0;
        for entry in &entries {
            let object = self.xref.fetch_if_ref(entry, false)?;
            functions += 1;
            if matches!(&object, Obj::Name(n) if &**n == "Identity") {
                maps.push(None);
                continue;
            }
            if !is_pdf_function(&object) {
                return Ok(None);
            }
            maps.push(Some(self.create_transfer_map(&object)?));
            effectful += 1;
        }
        if !(functions == 1 || functions == 4) || effectful == 0 {
            return Ok(None);
        }
        Ok(Some(maps))
    }

    // ---- patterns and shadings -----------------------------------------------------------------------------------

    /// The shading `sh` names: its id (one per shading object within the content stream).
    fn shading_operand(&mut self, name: &Obj, resources: &Dict, scope: &mut Scope) -> Result<ShadingRef> {
        let Obj::Name(name) = name else {
            return Err(format_error("Cannot read properties of undefined (reading 'name')"));
        };
        let Obj::Dict(shadings) = self.xref.get(resources, "Shading")? else {
            return Err(format_error("No shading resource found"));
        };
        let shading = self.xref.get(&shadings, name)?;
        if matches!(shading, Obj::Null) {
            return Err(format_error("No shading object found"));
        }
        Ok(self.shading_ref(shading, scope))
    }

    /// `parseShading`'s id: a shading met again within the stream keeps its id. The shading itself is handed on as
    /// the file holds it.
    fn shading_ref(&mut self, shading: Obj, scope: &mut Scope) -> ShadingRef {
        let identity = match &shading {
            Obj::Dict(d) => d.obj_id.clone(),
            Obj::Stream(s) => s.dict.obj_id.clone(),
            _ => None,
        };
        if let Some(key) = &identity
            && let Some(found) = scope.shadings.get(key)
        {
            return found.clone();
        }
        let object_id = self.create_obj_id();
        let id = format!("pattern_p{}_{}", self.page_index, object_id);
        let reference = ShadingRef { id, source: shading };
        if let Some(key) = identity {
            scope.shadings.insert(key, reference.clone());
        }
        reference
    }

    /// `handleColorN` for a Pattern colour space: the pattern operand is the last one.
    #[allow(clippy::too_many_arguments)]
    fn handle_color_n(
        &mut self,
        fill: bool,
        mut args: Vec<Obj>,
        space: &Arc<ColorSpace>,
        resources: &Arc<Dict>,
        op_list: &mut OperatorList,
        scope: &mut Scope,
        seen: &[String],
    ) -> Result<()> {
        let xref = self.xref;
        let name = args.pop().unwrap_or(Obj::Null);
        let Obj::Name(name) = name else {
            return Err(format_error("Unknown PatternName: [object Object]"));
        };
        let patterns = match xref.get(resources, "Pattern")? {
            Obj::Dict(d) => d,
            _ => Arc::new(Dict::new()),
        };
        let raw = patterns.get_raw(&name).cloned().unwrap_or(Obj::Null);
        let pattern = xref.fetch_if_ref(&raw, false)?;
        if !truthy(&pattern) {
            return Err(format_error(format!("Unknown PatternName: {name}")));
        }
        let dict = match &pattern {
            Obj::Stream(s) => s.dict.clone(),
            Obj::Dict(d) => d.clone(),
            _ => return Err(format_error(format!("Unknown PatternName: {name}"))),
        };
        let type_num = xref.get(&dict, "PatternType")?;
        match type_num.as_num() {
            Some(t) if t == 1.0 => {
                let color = match space.pattern_base() {
                    Some(base) => Some(base.get_rgb_hex(&args.iter().map(|a| a.as_num().unwrap_or(f64::NAN)).collect::<Vec<_>>(), 0)?),
                    None => None,
                };
                let outcome = self.handle_tiling_type(fill, color, resources, &pattern, &dict, op_list, seen);
                self.swallow("pattern", outcome)
            }
            Some(t) if t == 2.0 => {
                let shading = xref.get(&dict, "Shading")?;
                let reference = self.shading_ref(shading, scope);
                let matrix = number_array(&xref.get_array(&dict, "Matrix")?, 6).map(|m| [m[0], m[1], m[2], m[3], m[4], m[5]]);
                let pattern = Pattern::Shading { shading: reference, matrix };
                op_list.add_op(if fill { Op::SetFillPattern(pattern) } else { Op::SetStrokePattern(pattern) });
                Ok(())
            }
            _ => Err(format_error(format!("Unknown PatternType: {}", mixdog_js::number_to_string(type_num.as_num().unwrap_or(f64::NAN))))),
        }
    }

    /// `handleTilingType` and `getTilingPatternIR`.
    #[allow(clippy::too_many_arguments)]
    fn handle_tiling_type(
        &mut self,
        fill: bool,
        color: Option<String>,
        resources: &Arc<Dict>,
        pattern: &Obj,
        pattern_dict: &Arc<Dict>,
        op_list: &mut OperatorList,
        seen: &[String],
    ) -> Result<()> {
        let xref = self.xref;
        let Obj::Stream(stream) = pattern else {
            return Err(format_error("Tiling pattern is not a stream"));
        };
        let own = xref.get(pattern_dict, "Resources")?;
        let merged = Dict::merge(&[own, Obj::Dict(resources.clone())], false).unwrap_or_default();
        let pattern_resources = Arc::new(merged);
        let content = self.stream_bytes(stream)?;
        let mut cell = OperatorList::new();
        self.get_operator_list(content, stream.dict.obj_id.as_deref(), &pattern_resources, &mut cell, None, seen)?;
        let (needs_isolation, _) = isolation_of(cell.ops());
        let matrix = number_array(&xref.get_array(pattern_dict, "Matrix")?, 6).map_or(gstate::IDENTITY, |m| f64_array6(&m));
        let bbox = number_array(&xref.get_array(pattern_dict, "BBox")?, 4).map(|b| gstate::normalize_rect([b[0], b[1], b[2], b[3]]));
        let Some(bbox) = bbox.filter(|b| b[2] - b[0] != 0.0 && b[3] - b[1] != 0.0) else {
            return Err(format_error("Invalid getTilingPatternIR /BBox array."));
        };
        let Some(xstep) = xref.get(pattern_dict, "XStep")?.as_num() else {
            return Err(format_error("Invalid getTilingPatternIR /XStep value."));
        };
        let Some(ystep) = xref.get(pattern_dict, "YStep")?.as_num() else {
            return Err(format_error("Invalid getTilingPatternIR /YStep value."));
        };
        let paint_type = integer_of(&xref.get(pattern_dict, "PaintType")?).ok_or_else(|| format_error("Invalid getTilingPatternIR /PaintType value."))?;
        let tiling_type = integer_of(&xref.get(pattern_dict, "TilingType")?).ok_or_else(|| format_error("Invalid getTilingPatternIR /TilingType value."))?;
        let tiling = Pattern::Tiling(Box::new(TilingPattern {
            color,
            operator_list: Arc::new(cell),
            matrix,
            bbox,
            xstep,
            ystep,
            paint_type,
            tiling_type,
            needs_isolation,
        }));
        op_list.add_op(if fill { Op::SetFillPattern(tiling) } else { Op::SetStrokePattern(tiling) });
        Ok(())
    }

    // ---- fonts and text ------------------------------------------------------------------------------------------

    /// `ensureStateFont`: a text operator before any `Tf` is skipped (and an error without `ignoreErrors`).
    fn ensure_state_font(&self) -> Result<()> {
        let message = "Missing setFont (Tf) operator before text rendering operator.";
        if self.ignore_errors {
            tracing::warn!("ensureStateFont: \"{message}\".");
            Ok(())
        } else {
            Err(format_error(message))
        }
    }

    /// `handleText`: the glyphs of a shown string; a font that is not available shows none.
    fn handle_text(&self, chars: Option<&Obj>, state: &EvalState) -> Vec<super::Glyph> {
        let (Some(font), Some(Obj::Str(bytes))) = (&state.font, chars) else {
            return Vec::new();
        };
        match &font.font {
            Some(font) => font.chars_to_glyphs(bytes),
            None => Vec::new(),
        }
    }

    /// `handleSetFont`: the font becomes the state's font.
    fn handle_set_font(
        &mut self,
        font_name: Option<&str>,
        font: Option<&Obj>,
        resources: &Arc<Dict>,
        state: &mut EvalState,
        seen: &[String],
    ) -> Result<FontHandle> {
        let loaded = self.load_font(font_name, font, resources, seen)?;
        state.font = Some(loaded.clone());
        Ok(loaded)
    }

    fn error_font(&self) -> FontHandle {
        Arc::new(LoadedFont { loaded_name: "g_font_error".to_owned(), font: None, type3: None })
    }

    /// `loadFont`: the font of a resource name (or of a reference a graphics state names), translated by the font
    /// provider, with the glyph procedures of a Type3 font read. A font that cannot be found or translated is the
    /// error font; a missing font dictionary is replaced by Helvetica under `ignoreErrors`, as pdf.js does.
    fn load_font(&mut self, font_name: Option<&str>, font: Option<&Obj>, resources: &Arc<Dict>, seen: &[String]) -> Result<FontHandle> {
        let xref = self.xref;
        let mut font_ref: Option<Obj> = None;
        let mut font_obj: Option<Obj> = font.cloned();
        if let Some(Obj::Ref(_)) = font {
            font_ref = font.cloned();
        } else if matches!(font, None | Some(Obj::Null)) {
            font_obj = None;
            if let Obj::Dict(fonts) = xref.get(resources, "Font")?
                && let Some(name) = font_name
            {
                font_ref = fonts.get_raw(name).cloned();
            }
        }
        let mut key: Option<String> = None;
        if let Some(reference) = &font_ref
            && truthy(reference)
        {
            if let Obj::Ref(r) = reference {
                let id = r.to_string();
                if self.type3_font_refs.contains(&id) {
                    return Ok(self.error_font());
                }
                if let Some(cached) = self.font_cache.get(&id) {
                    return Ok(cached.clone());
                }
                key = Some(id);
            }
            match xref.fetch_if_ref(reference, false) {
                Ok(fetched) => font_obj = Some(fetched),
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => tracing::warn!("loadFont - lookup failed: \"{e}\"."),
            }
        }
        let dict: Arc<Dict> = match font_obj {
            Some(Obj::Dict(d)) => d,
            _ => {
                if !self.ignore_errors && !self.parsing_type3 {
                    tracing::warn!("Font \"{}\" is not available.", font_name.unwrap_or("undefined"));
                    return Ok(self.error_font());
                }
                tracing::warn!("Font \"{}\" is not available -- attempting to fallback to a default font.", font_name.unwrap_or("undefined"));
                fallback_font_dict()
            }
        };
        self.next_font += 1;
        let loaded_name = format!("f{}", self.next_font);
        let loaded = self.translate_font(&dict, loaded_name, resources, seen)?;
        if let Some(id) = key {
            self.font_cache.insert(id, loaded.clone());
        }
        Ok(loaded)
    }

    fn translate_font(&mut self, dict: &Arc<Dict>, loaded_name: String, resources: &Arc<Dict>, seen: &[String]) -> Result<FontHandle> {
        let Some(provider) = self.fonts else {
            if !self.warned_no_fonts {
                self.warned_no_fonts = true;
                tracing::error!("PDF text is not decoded: no font provider is attached to the operator-list pass, every font reads as unavailable.");
            }
            return Ok(Arc::new(LoadedFont { loaded_name, font: None, type3: None }));
        };
        let font = match provider.translate_font(dict, self.xref) {
            Ok(font) => font,
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => {
                tracing::warn!("loadFont - translateFont failed: \"{e}\".");
                return Ok(Arc::new(LoadedFont { loaded_name, font: None, type3: None }));
            }
        };
        let mut type3 = None;
        if font.is_type3() {
            match self.load_type3_data(dict, &font, resources, seen) {
                Ok(data) => type3 = Some(data),
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => {
                    tracing::warn!("loadFont - translateFont failed: \"Type3 font load error: {e}\".");
                    return Ok(Arc::new(LoadedFont { loaded_name, font: None, type3: None }));
                }
            }
        }
        provider.font_loaded(&loaded_name, &font);
        Ok(Arc::new(LoadedFont { loaded_name, font: Some(font), type3 }))
    }

    fn load_type3_data(&mut self, dict: &Arc<Dict>, font: &Arc<dyn super::FontObject>, resources: &Arc<Dict>, seen: &[String]) -> Result<Type3Data> {
        let xref = self.xref;
        let Obj::Dict(char_procs) = xref.get(dict, "CharProcs")? else {
            return Err(format_error("Cannot read properties of undefined (reading 'getKeys')"));
        };
        let font_resources = match xref.get(dict, "Resources")? {
            Obj::Dict(d) => d,
            _ => resources.clone(),
        };
        let [x0, y0, x1, y1] = font.bbox();
        let font_bbox_size = (x1 - x0).hypot(y1 - y0);
        let saved_ignore = std::mem::replace(&mut self.ignore_errors, false);
        let saved_parsing = std::mem::replace(&mut self.parsing_type3, true);
        let pushed = dict.obj_id.clone();
        if let Some(id) = &pushed {
            self.type3_font_refs.push(id.clone());
        }
        let mut procedures = Vec::new();
        let mut char_bbox: Option<[f32; 4]> = None;
        let mut failure: Option<PdfError> = None;
        for key in char_procs.keys().map(str::to_owned).collect::<Vec<_>>() {
            let mut list = OperatorList::new();
            let outcome = self
                .type3_procedure(&char_procs, &key, &font_resources, &mut list, seen)
                .and_then(|()| Self::finish_type3_procedure(&mut list, font_bbox_size, &mut char_bbox));
            match outcome {
                Ok(()) => {}
                Err(e) if e.is_fatal() => {
                    failure = Some(e);
                    break;
                }
                Err(_) => {
                    tracing::warn!("Type3 font resource \"{key}\" is not available.");
                    list = OperatorList::new();
                }
            }
            procedures.push((key, Arc::new(list)));
        }
        if pushed.is_some() {
            self.type3_font_refs.pop();
        }
        self.ignore_errors = saved_ignore;
        self.parsing_type3 = saved_parsing;
        if let Some(e) = failure {
            return Err(e);
        }
        Ok(Type3Data { procedures, char_bbox: char_bbox.map(|b| [f64::from(b[0]), f64::from(b[1]), f64::from(b[2]), f64::from(b[3])]) })
    }

    fn type3_procedure(&mut self, char_procs: &Arc<Dict>, key: &str, resources: &Arc<Dict>, list: &mut OperatorList, seen: &[String]) -> Result<()> {
        let Obj::Stream(stream) = self.xref.get(char_procs, key)? else {
            return Err(format_error("CharProc is not a stream"));
        };
        let content = self.stream_bytes(&stream)?;
        self.get_operator_list(content, stream.dict.obj_id.as_deref(), resources, list, None, seen)
    }

    /// The part of `loadType3Data` that reads the first operator of a glyph procedure.
    fn finish_type3_procedure(list: &mut OperatorList, font_bbox_size: f64, char_bbox: &mut Option<[f32; 4]>) -> Result<()> {
        let first = list.ops().first().cloned();
        match first {
            Some(Op::Param(ParamOp::SetCharWidthAndBounds, args)) => {
                remove_type3_color_operators(list, args, font_bbox_size, char_bbox);
            }
            Some(Op::Param(ParamOp::SetCharWidth, _)) if font_bbox_size == 0.0 || font_bbox_size.is_nan() => {
                for op in list.ops().iter().skip(1) {
                    if let Op::ConstructPath { path, .. } = op {
                        let Some(path) = path else {
                            return Err(format_error("Type3 glyph path has no bounding box"));
                        };
                        let bbox = char_bbox.get_or_insert(BBOX_INIT);
                        gstate::rect_bounding_box(
                            f64::from(path.min_max[0]),
                            f64::from(path.min_max[1]),
                            f64::from(path.min_max[2]),
                            f64::from(path.min_max[3]),
                            bbox,
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// `#removeType3ColorOperators`.
fn remove_type3_color_operators(list: &mut OperatorList, args: Vec<Obj>, font_bbox_size: f64, char_bbox: &mut Option<[f32; 4]>) {
    let n = |i: usize| number_at(&args, i);
    let rect = gstate::normalize_rect([n(2), n(3), n(4), n(5)]);
    let width = rect[2] - rect[0];
    let height = rect[3] - rect[1];
    let size = width.hypot(height);
    let ops = list.ops_mut();
    if width == 0.0 || height == 0.0 {
        ops.remove(0);
    } else if font_bbox_size == 0.0 || (size / font_bbox_size + 0.5).floor() >= 10.0 {
        let bbox = char_bbox.get_or_insert(BBOX_INIT);
        gstate::rect_bounding_box(rect[0], rect[1], rect[2], rect[3], bbox);
    }
    ops.retain(|op| {
        !matches!(
            op,
            Op::SetFillRgbColor(_)
                | Op::SetStrokeRgbColor(_)
                | Op::SetFillTransparent
                | Op::SetStrokeTransparent
                | Op::SetFillPattern(_)
                | Op::SetStrokePattern(_)
                | Op::ShadingFill(_)
                | Op::Param(ParamOp::SetRenderingIntent, _)
        )
    });
    for op in ops.iter_mut() {
        if let Op::SetGState(entries) = op {
            entries.retain(|(key, _)| key != "TR");
        }
    }
}

/// `CheckedOperatorList`'s two flags of a finished list: a blend mode other than normal or a soft mask needs the
/// group isolated, a soft mask also marks it as having one; a nested group passes its own flags up.
fn isolation_of(ops: &[Op]) -> (bool, bool) {
    let mut needs_isolation = false;
    let mut has_soft_mask = false;
    for op in ops {
        match op {
            Op::BeginGroup(group) => {
                needs_isolation |= group.needs_isolation;
                has_soft_mask |= group.has_soft_mask;
            }
            Op::SetGState(entries) => {
                for (key, value) in entries {
                    match (key.as_str(), value) {
                        ("BM", GStateValue::BlendMode(mode)) if *mode != "source-over" => {
                            needs_isolation = true;
                        }
                        ("SMask", GStateValue::Bool(false)) => {}
                        ("SMask", _) => {
                            needs_isolation = true;
                            has_soft_mask = true;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    (needs_isolation, has_soft_mask)
}

fn integer_of(obj: &Obj) -> Option<i64> {
    obj.as_int()
}

fn f64_array6(values: &[f64]) -> [f64; 6] {
    let mut out = [f64::NAN; 6];
    for (slot, &v) in out.iter_mut().zip(values) {
        *slot = v;
    }
    out
}

/// `PartialEvaluator.fallbackFontDict`: Helvetica with the Windows encoding.
fn fallback_font_dict() -> Arc<Dict> {
    let mut dict = Dict::new();
    dict.set("BaseFont", Obj::name("Helvetica"));
    dict.set("Type", Obj::name("FallbackType"));
    dict.set("Subtype", Obj::name("FallbackType"));
    dict.set("Encoding", Obj::name("WinAnsiEncoding"));
    Arc::new(dict)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::OpenOptions;

    fn build(objects: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets: Vec<(u32, usize)> = Vec::new();
        for (num, body) in objects {
            offsets.push((*num, out.len()));
            out.extend(format!("{num} 0 obj\n").as_bytes());
            out.extend(body);
            out.extend(b"\nendobj\n");
        }
        let last = objects.iter().map(|(n, _)| *n).max().unwrap_or(0);
        let xref_at = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", last + 1).as_bytes());
        for n in 1..=last {
            match offsets.iter().find(|(m, _)| *m == n) {
                Some((_, at)) => out.extend(format!("{at:010} 00000 n \n").as_bytes()),
                None => out.extend(b"0000000000 65535 f \n"),
            }
        }
        out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n", last + 1).as_bytes());
        out
    }

    fn stream_object(dict: &str, content: &str) -> Vec<u8> {
        format!("<< {dict} /Length {} >>\nstream\n{content}\nendstream", content.len()).into_bytes()
    }

    /// The operators of a one-page document with `content`, the page's `/Resources` entries and extra objects.
    fn ops_of(content: &str, resources: &str, extra: &[(u32, Vec<u8>)]) -> Vec<Op> {
        let mut objects: Vec<(u32, Vec<u8>)> = vec![
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
            (3, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << {resources} >> >>").into_bytes()),
            (4, stream_object("", content)),
        ];
        objects.extend(extra.iter().cloned());
        let document = Document::open(build(&objects), &OpenOptions::default()).expect("opens");
        let page = document.page(0).expect("page");
        crate::oplist::get_operator_list(&document, &page, None).expect("operator list").ops().to_vec()
    }

    #[test]
    fn a_rectangle_is_a_closed_single_precision_path() {
        let ops = ops_of("0.1 0.2 10 20 re f", "", &[]);
        let [Op::ConstructPath { paint, path: Some(path) }] = ops.as_slice() else {
            panic!("expected one path, got {ops:?}");
        };
        assert_eq!(*paint, PaintOp::Fill);
        assert_eq!(path.data.len(), 13);
        assert_eq!(path.data[1], 0.1_f32);
        assert_eq!(path.data[12], DRAW_CLOSE_PATH);
        assert_eq!(path.min_max, [0.1, 0.2, 10.1, 20.2]);
    }

    #[test]
    fn a_flat_rectangle_is_one_line() {
        let ops = ops_of("0 0 0 40 re f", "", &[]);
        let [Op::ConstructPath { path: Some(path), .. }] = ops.as_slice() else {
            panic!("expected one path");
        };
        assert_eq!(path.data, vec![0.0, 0.0, 0.0, 1.0, 0.0, 40.0, 4.0]);
    }

    #[test]
    fn surplus_operands_go_to_the_next_operator_and_a_short_one_is_skipped() {
        let ops = ops_of("7 1 0 0 1 5 6 cm 3 re 1 2 3 4 re f", "", &[]);
        assert!(matches!(&ops[0], Op::Transform(m) if *m == [1.0, 0.0, 0.0, 1.0, 5.0, 6.0]));
        assert!(matches!(&ops[1], Op::ConstructPath { paint: PaintOp::Fill, path: Some(_) }));
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn open_save_and_marked_content_are_closed_at_the_end() {
        let ops = ops_of("q q /A BMC 0 0 1 1 re f", "", &[]);
        let tail: Vec<&Op> = ops.iter().rev().take(3).collect();
        assert!(matches!(tail[0], Op::Restore));
        assert!(matches!(tail[1], Op::Restore));
        assert!(matches!(tail[2], Op::EndMarkedContent));
    }

    #[test]
    fn an_end_without_a_begin_is_ignored() {
        let ops = ops_of("EMC 0 0 1 1 re f", "", &[]);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn colours_are_converted_to_hex() {
        let ops = ops_of("1 0 0 rg 0.5 g 0 0 0 1 K", "", &[]);
        assert!(matches!(&ops[0], Op::SetFillRgbColor(h) if h == "#ff0000"));
        assert!(matches!(&ops[1], Op::SetFillRgbColor(_)));
        assert!(matches!(&ops[2], Op::SetStrokeRgbColor(_)));
    }

    #[test]
    fn a_form_is_bracketed_with_its_matrix_and_box() {
        let form = stream_object("/Type /XObject /Subtype /Form /Matrix [1 0 0 1 5 5] /BBox [0 0 50 50]", "0 0 20 20 re f q");
        let ops = ops_of("/F1 Do", "/XObject << /F1 10 0 R >>", &[(10, form)]);
        assert!(matches!(
            &ops[0],
            Op::FormBegin { matrix: Some(m), bbox: Some(b) }
                if *m == [1.0, 0.0, 0.0, 1.0, 5.0, 5.0] && *b == [0.0, 0.0, 50.0, 50.0]
        ));
        assert!(matches!(&ops[1], Op::ConstructPath { .. }));
        assert!(matches!(&ops[2], Op::Save));
        assert!(matches!(&ops[3], Op::Restore));
        assert!(matches!(&ops[4], Op::FormEnd));
    }

    #[test]
    fn a_form_that_paints_itself_stops_at_the_second_visit() {
        let form =
            stream_object("/Type /XObject /Subtype /Form /BBox [0 0 9 9] /Resources << /XObject << /F1 10 0 R >> >>", "0 0 5 5 re f /F1 Do 6 6 2 2 re f");
        let ops = ops_of("/F1 Do", "/XObject << /F1 10 0 R >>", &[(10, form)]);
        let paths = ops.iter().filter(|op| matches!(op, Op::ConstructPath { .. })).count();
        assert_eq!(paths, 2);
    }

    #[test]
    fn an_image_painted_twice_keeps_one_id() {
        let image = stream_object("/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", "ab");
        let ops = ops_of("q 10 0 0 10 0 0 cm /Im Do Q q 10 0 0 10 20 0 cm /Im Do Q", "/XObject << /Im 10 0 R >>", &[(10, image)]);
        let ids: Vec<&str> = ops
            .iter()
            .filter_map(|op| match op {
                Op::PaintImage(image) => Some(image.id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(ids[0], ids[1]);
    }

    #[test]
    fn text_without_a_font_provider_shows_no_glyphs() {
        let font = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec();
        let ops = ops_of("BT /F1 12 Tf (ab) Tj ET (no font yet) Tj", "/Font << /F1 10 0 R >>", &[(10, font)]);
        assert!(matches!(&ops[1], Op::SetFont { size, .. } if size.as_num() == Some(12.0)));
        assert!(matches!(&ops[2], Op::ShowText(items) if items.is_empty()));
    }

    #[test]
    fn a_run_of_invalid_path_operators_ends_the_stream_but_keeps_what_was_read() {
        let ops = ops_of("0 0 1 1 re f 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 1 re 2 2 3 3 re f", "", &[]);
        assert_eq!(ops.len(), 1);
    }

    #[test]
    fn graphics_state_entries_become_one_operator() {
        let ops = ops_of("/G gs", "/ExtGState << /G << /Type /ExtGState /LW -2 /BM /Multiply /ca 0.5 /SMask /None >> >>", &[]);
        let [Op::SetGState(entries)] = ops.as_slice() else {
            panic!("expected one setGState, got {ops:?}");
        };
        let keys: Vec<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["LW", "BM", "ca", "SMask"]);
        assert!(matches!(&entries[0].1, GStateValue::Number(n) if *n == 2.0));
        assert!(matches!(&entries[1].1, GStateValue::BlendMode("multiply")));
    }
}
