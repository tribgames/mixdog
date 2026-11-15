//! The operator list: what pdf.js's `getOperatorList` hands the renderer and the analysis, as typed events. Each
//! [`Op`] is one entry of pdf.js's `fnArray`/`argsArray` pair. The list is the one `page.getOperatorList()` returns,
//! which pdf.js builds without its queue optimizer (the display layer's `oplist` intent): operators are in the
//! order the content stream gave them, a repeated image is not folded into a group.

use std::sync::Arc;

use crate::object::Obj;
use crate::stream::PdfStream;

use super::Glyph;
use super::gstate::{self, Matrix};

/// `DrawOPS.moveTo`, `lineTo`, `curveTo`, `quadraticCurveTo`, `closePath`: the codes of a path buffer.
pub const DRAW_MOVE_TO: f32 = 0.0;
pub const DRAW_LINE_TO: f32 = 1.0;
pub const DRAW_CURVE_TO: f32 = 2.0;
pub const DRAW_QUADRATIC_CURVE_TO: f32 = 3.0;
pub const DRAW_CLOSE_PATH: f32 = 4.0;

/// The operator that ends a path: how it is painted (`OPS.stroke` ... `OPS.endPath`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaintOp {
    Stroke,
    CloseStroke,
    Fill,
    EoFill,
    FillStroke,
    EoFillStroke,
    CloseFillStroke,
    CloseEoFillStroke,
    EndPath,
}

impl PaintOp {
    /// The operator paints the path's outline (`stroke`, `closeStroke` and the four fill-and-stroke ones).
    pub fn strokes(self) -> bool {
        matches!(
            self,
            PaintOp::Stroke
                | PaintOp::CloseStroke
                | PaintOp::FillStroke
                | PaintOp::EoFillStroke
                | PaintOp::CloseFillStroke
                | PaintOp::CloseEoFillStroke
        )
    }

    /// The operator paints the path's inside (`fill`, `eoFill` and the four fill-and-stroke ones).
    pub fn fills(self) -> bool {
        matches!(
            self,
            PaintOp::Fill
                | PaintOp::EoFill
                | PaintOp::FillStroke
                | PaintOp::EoFillStroke
                | PaintOp::CloseFillStroke
                | PaintOp::CloseEoFillStroke
        )
    }
}

/// A path: the `Float32Array` of codes and coordinates and its bounding box `[minX, minY, maxX, maxY]`.
#[derive(Debug, Clone, PartialEq)]
pub struct PathData {
    pub data: Vec<f32>,
    pub min_max: [f32; 4],
}

/// One subpath of a path buffer (`pathSubpaths` of the analysis): its points, the end point of a curve counted as one.
#[derive(Debug, Clone, PartialEq)]
pub struct Subpath {
    pub points: Vec<(f64, f64)>,
    pub curved: bool,
}

impl PathData {
    /// The subpaths of the buffer, read as the analysis reads it: a move starts one, a line adds its end point, a
    /// curve adds its end point and marks the subpath curved, a close changes nothing, anything else stops.
    pub fn subpaths(&self) -> Vec<Subpath> {
        let data = &self.data;
        let mut subpaths: Vec<Subpath> = Vec::new();
        let mut k = 0;
        let at = |i: usize| f64::from(data.get(i).copied().unwrap_or(f32::NAN));
        while k < data.len() {
            let code = data[k];
            k += 1;
            if code == DRAW_MOVE_TO {
                subpaths.push(Subpath {
                    points: vec![(at(k), at(k + 1))],
                    curved: false,
                });
                k += 2;
            } else if code == DRAW_LINE_TO {
                if let Some(last) = subpaths.last_mut() {
                    last.points.push((at(k), at(k + 1)));
                }
                k += 2;
            } else if code == DRAW_CURVE_TO || code == DRAW_QUADRATIC_CURVE_TO {
                let span = if code == DRAW_CURVE_TO { 6 } else { 4 };
                if let Some(last) = subpaths.last_mut() {
                    last.points.push((at(k + span - 2), at(k + span - 1)));
                    last.curved = true;
                }
                k += span;
            } else if code != DRAW_CLOSE_PATH {
                break;
            }
        }
        subpaths
    }
}

/// The reference of an image the page paints (`paintImageXObject`'s `[objId, width, height]`): the image is the
/// stream `source`, the id is what the display layer keys it by.
#[derive(Debug, Clone)]
pub struct ImageRef {
    pub id: String,
    pub width: f64,
    pub height: f64,
    pub source: Arc<PdfStream>,
}

/// A small inline image (`paintInlineImageXObject`): the stream the `BI ... EI` made.
#[derive(Debug, Clone)]
pub struct InlineImage {
    pub width: f64,
    pub height: f64,
    pub source: Arc<PdfStream>,
    /// The pixels `createImageData(true)` made while the operator list was built (a failure there drops the image).
    pub decoded: Arc<crate::image::ImageData>,
}

/// One entry of a `setGState`: the key and what pdf.js keeps of the value.
#[derive(Debug, Clone)]
pub enum GStateValue {
    Number(f64),
    Bool(bool),
    /// A PDF value kept as read (`LC`, `LJ`, `ML`, `D`, `RI`, `FL`, `CA`, `ca`).
    Value(Obj),
    /// `BM`: the canvas composite operation name.
    BlendMode(&'static str),
    /// `Font`: the loaded name and the size.
    Font {
        loaded_name: String,
        size: Obj,
    },
    /// `TR`: one 256-entry map, or four, or none for the identity; `None` when the transfer function is unusable.
    Transfer(Option<Vec<Option<Vec<u8>>>>),
}

/// The options of a transparency group form (`beginGroup`).
#[derive(Debug, Clone)]
pub struct Group {
    pub matrix: Option<[f64; 6]>,
    pub bbox: Option<[f32; 4]>,
    pub smask: Option<SoftMask>,
    pub isolated: bool,
    pub knockout: bool,
    pub needs_isolation: bool,
    pub has_soft_mask: bool,
    pub is_gray: bool,
}

/// A soft mask a group is painted under (`handleSMask`'s options).
#[derive(Debug, Clone)]
pub struct SoftMask {
    pub subtype: String,
    pub backdrop: Option<String>,
    pub transfer_map: Option<Vec<u8>>,
}

/// Optional content a `BDC`, a form or an image names (`parseMarkedContentProps`).
#[derive(Debug, Clone, PartialEq)]
pub enum OptionalContent {
    Group {
        id: Option<String>,
    },
    Membership {
        ids: Vec<String>,
        policy: Option<String>,
        expression: Option<Vec<Expression>>,
    },
    /// An OCMD with exactly one group.
    MembershipOne {
        id: String,
    },
}

/// An element of an optional-content visibility expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expression {
    Operator(String),
    Reference(String),
    Nested(Vec<Expression>),
}

/// The second argument of `beginMarkedContentProps`.
#[derive(Debug, Clone)]
pub enum MarkedData {
    /// The `MCID` of the property list (`null` when it has none).
    Mcid(Obj),
    /// `OC`: the optional content, `None` when it could not be read.
    OptionalContent(Option<OptionalContent>),
}

/// A shading (`sh`, or the shading of a shading pattern): the id the display layer keys it by and the shading
/// object as the file holds it (a dictionary, or a stream for a mesh).
#[derive(Debug, Clone)]
pub struct ShadingRef {
    pub id: String,
    pub source: Obj,
}

/// A pattern a colour operator selects.
#[derive(Debug, Clone)]
pub enum Pattern {
    /// `["Shading", id, matrix]`.
    Shading {
        shading: ShadingRef,
        matrix: Option<[f64; 6]>,
    },
    Tiling(Box<TilingPattern>),
}

/// `getTilingPatternIR`: the cell's operator list and the pattern's parameters.
#[derive(Debug, Clone)]
pub struct TilingPattern {
    pub color: Option<String>,
    pub operator_list: Arc<OperatorList>,
    pub matrix: [f64; 6],
    pub bbox: [f64; 4],
    pub xstep: f64,
    pub ystep: f64,
    pub paint_type: i64,
    pub tiling_type: i64,
    pub needs_isolation: bool,
}

/// One element of a `showText`: a glyph, or a `TJ` adjustment in thousandths of the text space.
#[derive(Debug, Clone)]
pub enum TextItem {
    Glyph(Glyph),
    Adjust(f64),
}

/// The operators whose arguments pdf.js passes on as they are read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamOp {
    SetLineCap,
    SetLineJoin,
    SetMiterLimit,
    SetRenderingIntent,
    SetFlatness,
    SetCharSpacing,
    SetWordSpacing,
    SetHScale,
    SetLeading,
    SetTextRenderingMode,
    SetTextRise,
    MoveText,
    SetLeadingMoveText,
    NextLine,
    SetCharWidth,
    SetCharWidthAndBounds,
}

/// One entry of the operator list.
#[derive(Debug, Clone)]
pub enum Op {
    Save,
    Restore,
    Transform(Matrix),
    /// `constructPath`: how the path is painted and the path (`None` for an empty one).
    ConstructPath {
        paint: PaintOp,
        path: Option<PathData>,
    },
    Clip,
    EoClip,
    SetLineWidth(f64),
    SetDash {
        array: Vec<f64>,
        phase: f64,
    },
    SetGState(Vec<(String, GStateValue)>),
    Param(ParamOp, Vec<Obj>),
    BeginText,
    EndText,
    /// `setFont`: the name the font was loaded under and the size as written.
    SetFont {
        loaded_name: String,
        size: Obj,
    },
    ShowText(Vec<TextItem>),
    SetTextMatrix([f32; 6]),
    /// `setFillRGBColor` / `setStrokeRGBColor`: `#rrggbb`.
    SetFillRgbColor(String),
    SetStrokeRgbColor(String),
    SetFillTransparent,
    SetStrokeTransparent,
    SetFillPattern(Pattern),
    SetStrokePattern(Pattern),
    ShadingFill(ShadingRef),
    /// `paintFormXObjectBegin`: the form's matrix and, when it has no group, its bounding box.
    FormBegin {
        matrix: Option<[f32; 6]>,
        bbox: Option<[f32; 4]>,
    },
    FormEnd,
    BeginGroup(Group),
    EndGroup(Group),
    PaintImage(ImageRef),
    PaintInlineImage(InlineImage),
    PaintImageMask(ImageRef),
    PaintSolidColorImageMask,
    /// `beginMarkedContent`: the tag.
    BeginMarkedContent(Option<String>),
    BeginMarkedContentProps {
        tag: String,
        data: MarkedData,
    },
    EndMarkedContent,
}

// ---- the list --------------------------------------------------------------------------------------------------------

/// The operator list of a page, a form, a pattern cell or a Type3 glyph.
#[derive(Debug, Default)]
pub struct OperatorList {
    ops: Vec<Op>,
}

impl OperatorList {
    pub fn new() -> Self {
        OperatorList::default()
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// `addOp`.
    pub fn add_op(&mut self, op: Op) {
        self.ops.push(op);
    }

    /// `addOpList`.
    pub fn add_op_list(&mut self, other: OperatorList) {
        self.ops.extend(other.ops);
    }

    /// The operators in order.
    pub fn ops(&self) -> &[Op] {
        &self.ops
    }

    /// The operators of a list, for the callers that edit it (the colour operators of a Type3 glyph are removed).
    pub(crate) fn ops_mut(&mut self) -> &mut Vec<Op> {
        &mut self.ops
    }

    /// The paths, images and form boundaries with the transform in force where they are painted. This is the walk
    /// the analysis does (`applyGraphicsOp`): `q`/`Q` and form begin/end push and pop, `cm` and a form matrix
    /// multiply.
    pub fn with_transforms(&self) -> Vec<(Matrix, &Op)> {
        let mut stack: Vec<Matrix> = Vec::new();
        let mut ctm = gstate::IDENTITY;
        let mut out = Vec::with_capacity(self.ops.len());
        for op in &self.ops {
            match op {
                Op::Save => stack.push(ctm),
                Op::Restore => ctm = stack.pop().unwrap_or(ctm),
                Op::Transform(m) => ctm = gstate::transform(&ctm, m),
                Op::FormBegin { matrix, .. } => {
                    stack.push(ctm);
                    if let Some(m) = matrix {
                        let m: Vec<f64> = m.iter().map(|&x| f64::from(x)).collect();
                        ctm = gstate::transform(&ctm, &m);
                    }
                }
                Op::FormEnd => ctm = stack.pop().unwrap_or(ctm),
                _ => {}
            }
            out.push((ctm, op));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subpaths_follow_the_analysis_reading() {
        let path = PathData {
            data: vec![
                DRAW_MOVE_TO,
                1.0,
                2.0,
                DRAW_CURVE_TO,
                0.0,
                0.0,
                0.0,
                0.0,
                5.0,
                6.0,
                DRAW_CLOSE_PATH,
                DRAW_MOVE_TO,
                7.0,
                8.0,
                DRAW_LINE_TO,
                9.0,
                8.0,
            ],
            min_max: [0.0; 4],
        };
        let subpaths = path.subpaths();
        assert_eq!(subpaths.len(), 2);
        assert!(subpaths[0].curved);
        assert_eq!(subpaths[0].points, vec![(1.0, 2.0), (5.0, 6.0)]);
        assert_eq!(subpaths[1].points, vec![(7.0, 8.0), (9.0, 8.0)]);
    }

    #[test]
    fn transforms_accumulate_through_form_boundaries() {
        let mut list = OperatorList::new();
        list.add_op(Op::Transform([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]));
        list.add_op(Op::FormBegin {
            matrix: Some([1.0, 0.0, 0.0, 1.0, 5.0, 0.0]),
            bbox: None,
        });
        list.add_op(Op::ConstructPath {
            paint: PaintOp::Fill,
            path: None,
        });
        list.add_op(Op::FormEnd);
        let walked = list.with_transforms();
        assert_eq!(walked[2].0, [2.0, 0.0, 0.0, 2.0, 10.0, 0.0]);
        assert_eq!(walked[3].0, [2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn paint_ops_say_what_they_paint() {
        assert!(PaintOp::FillStroke.fills() && PaintOp::FillStroke.strokes());
        assert!(PaintOp::Fill.fills() && !PaintOp::Fill.strokes());
        assert!(!PaintOp::EndPath.fills() && !PaintOp::EndPath.strokes());
    }
}
