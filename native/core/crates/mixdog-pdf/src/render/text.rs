//! Text on the page: `CanvasGraphics.showText`, `paintChar`, `endText` and the text-state operators of pdf.js's
//! `src/display/canvas.js`, drawn from glyph outlines (in Node pdf.js draws every glyph as a path: `disableFontFace` is
//! on) in all four rendering modes of the fill/stroke pair (fill, stroke, fill and stroke, invisible) and the clipping
//! variants (`ADD_TO_PATH_FLAG`: the outlines collected during the text object clip what follows `ET`).
//!
//! The outlines themselves come through [`FontDrawing`], the seam of the font object that draws (pdf.js's
//! `FontFaceObject.getPathGenerator`): the glyph outline of a [`Glyph`] in text space, with the font matrix already
//! applied, as `crate::glyph::FontRenderer::get_path` returns it.

use std::sync::Arc;

use mixdog_raster::canvas::FillRule;

use crate::oplist::gstate::{self, Matrix};
use crate::oplist::{Glyph, TextItem};

use super::painter::{Painter, invert, path_from_buffer, skia};

/// `FONT_IDENTITY_MATRIX`.
pub(super) const FONT_IDENTITY_MATRIX: Matrix = [0.001, 0.0, 0.0, 0.001, 0.0, 0.0];

/// `TextRenderingMode.FILL_STROKE_MASK` and `ADD_TO_PATH_FLAG`.
const FILL_STROKE_MASK: i64 = 3;
const ADD_TO_PATH_FLAG: i64 = 4;
const MODE_FILL: i64 = 0;
const MODE_STROKE: i64 = 1;
const MODE_FILL_STROKE: i64 = 2;

/// What drawing needs to know of a font object (`FontFaceObject`).
#[derive(Debug, Clone, PartialEq)]
pub struct DrawnFont {
    /// `fontMatrix`: the glyph space to text space matrix (`FONT_IDENTITY_MATRIX` unless the font has its own).
    pub font_matrix: [f64; 6],
    pub vertical: bool,
    pub type3: bool,
    /// `missingFile`: the font has no program of its own.
    pub missing_file: bool,
}

/// The outline of one glyph, and of the accent of a glyph drawn in two parts.
#[derive(Debug, Clone, Default)]
pub struct GlyphDraw {
    /// The path words (`MOVE_TO` and friends followed by their coordinates, as `crate::glyph` builds them), `None` for a
    /// glyph without an outline (a space).
    pub path: Option<Arc<Vec<f32>>>,
    pub accent: Option<AccentDraw>,
}

/// `glyph.accent`: its own outline and where it sits against the base glyph, in text space units.
#[derive(Debug, Clone)]
pub struct AccentDraw {
    pub path: Option<Arc<Vec<f32>>>,
    pub offset_x: f64,
    pub offset_y: f64,
}

/// The fonts the page was loaded with, as far as drawing asks (`commonObjs.get(loadedName)` and
/// `font.getPathGenerator`).
pub trait FontDrawing {
    /// The font loaded under `loaded_name`; `None` for the font that could not be made (its text draws nothing).
    fn font(&self, loaded_name: &str) -> Option<DrawnFont>;

    /// The outline of `glyph` in the font loaded under `loaded_name`.
    fn glyph(&self, loaded_name: &str, glyph: &Glyph) -> GlyphDraw;
}

/// One entry of `pendingTextPaths`.
pub(super) struct TextClipPath {
    transform: Matrix,
    x: f64,
    y: f64,
    font_size: f64,
    path: Option<Arc<Vec<f32>>>,
}

impl Painter<'_> {
    // ---- the text state ------------------------------------------------------------------------------------------

    /// `beginText`.
    pub(super) fn begin_text(&mut self) {
        let current = &mut self.current;
        current.text_matrix = None;
        current.text_matrix_scale = 1.0;
        current.x = 0.0;
        current.line_x = 0.0;
        current.y = 0.0;
        current.line_y = 0.0;
    }

    /// `setTextMatrix`.
    pub(super) fn set_text_matrix(&mut self, matrix: &[f32; 6]) {
        let matrix: Matrix = matrix.map(f64::from);
        let current = &mut self.current;
        current.text_matrix_scale = matrix[0].hypot(matrix[1]);
        current.text_matrix = Some(matrix);
        current.x = 0.0;
        current.line_x = 0.0;
        current.y = 0.0;
        current.line_y = 0.0;
    }

    /// `moveText`.
    pub(super) fn move_text(&mut self, x: f64, y: f64) {
        let current = &mut self.current;
        current.line_x += x;
        current.x = current.line_x;
        current.line_y += y;
        current.y = current.line_y;
    }

    /// `setFont`: a negative size flips the direction of the text.
    pub(super) fn set_font(&mut self, loaded_name: &str, size: f64) {
        let font = self.drawing.and_then(|drawing| drawing.font(loaded_name));
        let current = &mut self.current;
        current.font_matrix = font
            .as_ref()
            .map_or(FONT_IDENTITY_MATRIX, |font| font.font_matrix);
        if size < 0.0 {
            current.font_size = -size;
            current.font_direction = -1.0;
        } else {
            current.font_size = size;
            current.font_direction = 1.0;
        }
        current.font_name = loaded_name.to_owned();
        current.font = font;
    }

    // ---- showing --------------------------------------------------------------------------------------------------

    /// `showText` (`showType3Text` for a Type3 font, whose glyph procedures the paint stage draws: here the text
    /// position moves as it does there).
    pub(super) fn show_text(&mut self, items: &[TextItem]) {
        let Some(drawing) = self.drawing else {
            self.report_once(
                "no-fonts",
                "text was not drawn: no font drawing was supplied to the rasteriser",
            );
            return;
        };
        let Some(font) = self.current.font.clone() else {
            return;
        };
        if font.type3 {
            self.advance_type3_text(items);
            return;
        }
        let font_size = self.current.font_size;
        if font_size == 0.0 {
            return;
        }
        let char_spacing = self.current.char_spacing;
        let word_spacing = self.current.word_spacing;
        let direction = self.current.font_direction;
        let hscale = self.current.text_hscale * direction;
        let spacing_direction = if font.vertical { 1.0 } else { -1.0 };
        let advance_scale = font_size * self.current.font_matrix[0];
        let mode = self.current.text_rendering_mode & FILL_STROKE_MASK;
        let needs_stroke = mode == MODE_STROKE || mode == MODE_FILL_STROKE;

        self.canvas.save();
        if let Some(matrix) = self.current.text_matrix {
            self.canvas.transform(
                matrix[0] as f32,
                matrix[1] as f32,
                matrix[2] as f32,
                matrix[3] as f32,
                matrix[4] as f32,
                matrix[5] as f32,
            );
        }
        self.canvas
            .translate(self.current.x as f32, (self.current.y + self.current.text_rise) as f32);
        if direction > 0.0 {
            self.canvas.scale(hscale as f32, -1.0);
        } else {
            self.canvas.scale(hscale as f32, 1.0);
        }
        let mut line_width = self.current.line_width;
        let scale = self.current.text_matrix_scale;
        if scale == 0.0 || line_width == 0.0 {
            if needs_stroke {
                line_width = self.single_pixel_width();
            }
        } else {
            line_width /= scale;
        }
        self.canvas.set_line_width(line_width as f32);

        let mut x = 0.0;
        for item in items {
            let glyph = match item {
                TextItem::Adjust(adjustment) => {
                    x += spacing_direction * adjustment * font_size / 1000.0;
                    continue;
                }
                TextItem::Glyph(glyph) => glyph,
            };
            let spacing = (if glyph.is_space { word_spacing } else { 0.0 }) + char_spacing;
            let mut width = glyph.width;
            let (scaled_x, scaled_y);
            if font.vertical {
                let vmetric = glyph.vmetric.unwrap_or([0.0, 0.0, 0.0]);
                let vx = -vmetric[1] * advance_scale;
                let vy = vmetric[2] * advance_scale;
                width = -vmetric[0];
                scaled_x = vx;
                scaled_y = x + vy;
            } else {
                scaled_x = x;
                scaled_y = 0.0;
            }
            if self.content_visible && (glyph.is_in_font || font.missing_file) {
                let draw = drawing.glyph(&self.current.font_name, glyph);
                self.paint_char(draw.path.as_ref(), scaled_x, scaled_y);
                if let Some(accent) = &draw.accent {
                    self.paint_char(
                        accent.path.as_ref(),
                        scaled_x + font_size * accent.offset_x,
                        scaled_y - font_size * accent.offset_y,
                    );
                }
            }
            let char_width = if font.vertical {
                width * advance_scale - spacing * direction
            } else {
                width * advance_scale + spacing * direction
            };
            x += char_width;
        }
        if font.vertical {
            self.current.y -= x;
        } else {
            self.current.x += x * hscale;
        }
        self.canvas.restore();
    }

    /// The text position after a Type3 string (`showType3Text` without the glyph procedures).
    fn advance_type3_text(&mut self, items: &[TextItem]) {
        let current = &self.current;
        if current.text_rendering_mode == 3 || current.font_size == 0.0 {
            return;
        }
        let spacing_direction = if current.font.as_ref().is_some_and(|font| font.vertical) {
            1.0
        } else {
            -1.0
        };
        let hscale = current.text_hscale * current.font_direction;
        let mut advanced = 0.0;
        for item in items {
            match item {
                TextItem::Adjust(adjustment) => {
                    advanced += spacing_direction * adjustment * current.font_size / 1000.0 * hscale;
                }
                TextItem::Glyph(glyph) => {
                    let spacing =
                        (if glyph.is_space { current.word_spacing } else { 0.0 }) + current.char_spacing;
                    let width = gstate::apply_point(glyph.width, 0.0, &current.font_matrix).0
                        * current.font_size
                        + spacing;
                    advanced += width * hscale;
                }
            }
        }
        self.current.x += advanced;
        self.report_once(
            "type3",
            "Type3 glyph procedures are drawn by the paint stage of the rasteriser",
        );
    }

    /// `paintChar`: the outline at `(x, y)` of the text space, filled and/or stroked by the rendering mode, and
    /// remembered for the clip of a clipping mode.
    fn paint_char(&mut self, path: Option<&Arc<Vec<f32>>>, x: f64, y: f64) {
        let mode = self.current.text_rendering_mode;
        let fill_stroke = mode & FILL_STROKE_MASK;
        let add_to_path = mode & ADD_TO_PATH_FLAG != 0;
        let font_size = self.current.font_size;
        if let Some(path) = path
            && !self.current.pattern_fill
            && !self.current.pattern_stroke
        {
            let outline = path_from_buffer(path);
            self.canvas.save();
            self.canvas.translate(x as f32, y as f32);
            self.canvas.scale(font_size as f32, -(font_size as f32));
            if fill_stroke == MODE_FILL || fill_stroke == MODE_FILL_STROKE {
                self.canvas.fill_path2d(&outline, FillRule::Winding);
            }
            if fill_stroke == MODE_STROKE || fill_stroke == MODE_FILL_STROKE {
                let width = self.canvas.line_width();
                self.canvas.set_line_width(width / font_size as f32);
                self.canvas.stroke_path2d(&outline);
            }
            self.canvas.restore();
        } else if path.is_some() {
            self.report_once(
                "pattern",
                "text painted with a pattern is drawn by the paint stage of the rasteriser",
            );
        }
        if add_to_path {
            let transform = self.ctm();
            self.pending_text_paths
                .get_or_insert_with(Vec::new)
                .push(TextClipPath {
                    transform,
                    x,
                    y,
                    font_size,
                    path: path.cloned(),
                });
        }
    }

    /// `endText`: the outlines a clipping mode collected become the clip (an empty collection clips everything away,
    /// as pdf.js's empty `Path2D` does).
    pub(super) fn end_text(&mut self) {
        let Some(paths) = self.pending_text_paths.take() else {
            return;
        };
        let Some(inverse) = invert(&self.ctm()) else {
            return;
        };
        let mut combined = mixdog_raster::canvas::Path2D::new();
        for entry in paths {
            let Some(path) = &entry.path else { continue };
            let outline = path_from_buffer(path);
            let placed = gstate::transform(
                &gstate::transform(&inverse, &entry.transform),
                &[1.0, 0.0, 0.0, 1.0, entry.x, entry.y],
            );
            let placed = gstate::transform(&placed, &[entry.font_size, 0.0, 0.0, -entry.font_size, 0.0, 0.0]);
            combined.add_path(&outline, skia(&placed));
        }
        self.canvas.clip_path2d(&combined, FillRule::Winding);
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::glyph::{CLOSE_PATH, LINE_TO, MOVE_TO};
    use crate::render::painter::OptionalContentConfig;
    use crate::document::{Document, OpenOptions};
    use mixdog_raster::canvas::Canvas;

    /// A font whose every glyph is the unit square (0,0)-(1,1) of the em.
    struct Squares {
        asked: RefCell<Vec<u32>>,
    }

    impl FontDrawing for Squares {
        fn font(&self, loaded_name: &str) -> Option<DrawnFont> {
            (loaded_name == "g_f1").then(|| DrawnFont {
                font_matrix: FONT_IDENTITY_MATRIX,
                vertical: false,
                type3: false,
                missing_file: false,
            })
        }

        fn glyph(&self, _: &str, glyph: &Glyph) -> GlyphDraw {
            self.asked.borrow_mut().push(glyph.original_char_code);
            if glyph.is_space {
                return GlyphDraw::default();
            }
            GlyphDraw {
                path: Some(Arc::new(vec![
                    MOVE_TO, 0.0, 0.0, LINE_TO, 1.0, 0.0, LINE_TO, 1.0, 1.0, LINE_TO, 0.0, 1.0, CLOSE_PATH,
                ])),
                accent: None,
            }
        }
    }

    fn glyph(code: u32, width: f64, is_space: bool) -> Glyph {
        Glyph {
            width,
            original_char_code: code,
            font_char: String::new(),
            unicode: String::new(),
            accent: None,
            vmetric: None,
            operator_list_id: None,
            is_space,
            is_in_font: true,
        }
    }

    fn pdf_document() -> Document {
        let mut pdf = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (number, body) in [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>",
        ]
        .iter()
        .enumerate()
        {
            offsets.push(pdf.len());
            pdf.push_str(&format!("{} 0 obj\n{body}\nendobj\n", number + 1));
        }
        let xref = pdf.len();
        pdf.push_str("xref\n0 4\n0000000000 65535 f \n");
        for offset in offsets {
            pdf.push_str(&format!("{offset:010} 00000 n \n"));
        }
        pdf.push_str(&format!("trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        Document::open(pdf.into_bytes(), &OpenOptions::default()).expect("the page opens")
    }

    /// The painter over a 100 by 100 white canvas, a text matrix of 1 and a font size of 10.
    fn painter<'a>(document: &'a Document, drawing: &'a Squares) -> Painter<'a> {
        let canvas = Canvas::new(100, 100).expect("canvas");
        let resources = Arc::new(crate::object::Dict::new());
        let mut painter = Painter::new(
            canvas,
            document,
            resources,
            Some(drawing),
            OptionalContentConfig::default(),
        );
        painter.canvas.set_fill_color("rgb(255,255,255)");
        painter.canvas.fill_rect(0.0, 0.0, 100.0, 100.0);
        painter.canvas.set_fill_color("#000000");
        painter.set_font("g_f1", 10.0);
        painter
    }

    fn dark(painter: &Painter<'_>, x: i32, y: i32) -> bool {
        let data = painter.canvas.get_image_data(x, y, 1, 1).expect("pixel");
        data.data()[0] < 128
    }

    #[test]
    fn glyphs_advance_by_their_width_and_are_drawn_upright_from_the_baseline() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.canvas.transform(1.0, 0.0, 0.0, -1.0, 0.0, 100.0);
        painter.begin_text();
        painter.set_text_matrix(&[1.0, 0.0, 0.0, 1.0, 20.0, 30.0]);
        painter.show_text(&[
            TextItem::Glyph(glyph(65, 1000.0, false)),
            TextItem::Adjust(-500.0),
            TextItem::Glyph(glyph(66, 1000.0, false)),
        ]);
        // The first square covers x 20..30 above the baseline y = 30 (device rows 60..70), the second sits 15 units on.
        assert!(dark(&painter, 25, 65));
        assert!(!dark(&painter, 32, 65));
        assert!(dark(&painter, 40, 65));
        assert!((painter.current.x - 25.0).abs() < 1e-9, "x = {}", painter.current.x);
        assert_eq!(*drawing.asked.borrow(), vec![65, 66]);
    }

    #[test]
    fn character_and_word_spacing_move_the_next_glyph() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.current.char_spacing = 2.0;
        painter.current.word_spacing = 3.0;
        painter.show_text(&[
            TextItem::Glyph(glyph(32, 250.0, true)),
            TextItem::Glyph(glyph(65, 500.0, false)),
        ]);
        // 250 units of a 10 point font are 2.5, plus 3 for the space and 2 for each character; then 5 and 2.
        assert!((painter.current.x - (2.5 + 3.0 + 2.0 + 5.0 + 2.0)).abs() < 1e-9);
    }

    #[test]
    fn an_invisible_mode_draws_nothing_and_a_stroke_mode_draws_the_outline_only() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.canvas.transform(1.0, 0.0, 0.0, -1.0, 0.0, 100.0);
        painter.current.text_matrix = None;
        painter.current.x = 20.0;
        painter.current.y = 30.0;
        painter.current.text_rendering_mode = 3;
        painter.show_text(&[TextItem::Glyph(glyph(65, 1000.0, false))]);
        assert!(!dark(&painter, 25, 65));
        painter.current.x = 20.0;
        painter.current.text_rendering_mode = 1;
        painter.current.line_width = 4.0;
        painter.canvas.set_stroke_color("#000000");
        painter.show_text(&[TextItem::Glyph(glyph(65, 1000.0, false))]);
        assert!(!dark(&painter, 25, 65), "the inside of a stroked square stays white");
        assert!(dark(&painter, 20, 65), "its edge is inked");
    }

    #[test]
    fn a_clipping_mode_clips_what_follows_the_text_object() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.canvas.transform(1.0, 0.0, 0.0, -1.0, 0.0, 100.0);
        painter.begin_text();
        painter.set_text_matrix(&[1.0, 0.0, 0.0, 1.0, 20.0, 30.0]);
        painter.current.text_rendering_mode = 7;
        painter.show_text(&[TextItem::Glyph(glyph(65, 1000.0, false))]);
        painter.end_text();
        painter.canvas.fill_rect(0.0, 0.0, 100.0, 100.0);
        assert!(dark(&painter, 25, 65), "inside the glyph the page is painted");
        assert!(!dark(&painter, 60, 65), "outside it the clip holds");
    }

    #[test]
    fn a_font_that_could_not_be_made_draws_nothing_and_does_not_move() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.set_font("g_font_error", 10.0);
        painter.show_text(&[TextItem::Glyph(glyph(65, 1000.0, false))]);
        assert_eq!(painter.current.x, 0.0);
        assert!(drawing.asked.borrow().is_empty());
    }

    #[test]
    fn a_negative_font_size_reads_the_text_the_other_way() {
        let document = pdf_document();
        let drawing = Squares { asked: RefCell::new(Vec::new()) };
        let mut painter = painter(&document, &drawing);
        painter.set_font("g_f1", -10.0);
        assert_eq!(painter.current.font_size, 10.0);
        assert_eq!(painter.current.font_direction, -1.0);
        painter.show_text(&[TextItem::Glyph(glyph(65, 1000.0, false))]);
        assert!((painter.current.x + 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_type3_string_moves_the_position_by_its_widths() {
        struct Type3;
        impl FontDrawing for Type3 {
            fn font(&self, _: &str) -> Option<DrawnFont> {
                Some(DrawnFont {
                    font_matrix: [0.01, 0.0, 0.0, 0.01, 0.0, 0.0],
                    vertical: false,
                    type3: true,
                    missing_file: false,
                })
            }
            fn glyph(&self, _: &str, _: &Glyph) -> GlyphDraw {
                GlyphDraw::default()
            }
        }
        let document = pdf_document();
        let canvas = Canvas::new(10, 10).expect("canvas");
        let mut painter = Painter::new(
            canvas,
            &document,
            Arc::new(crate::object::Dict::new()),
            Some(&Type3),
            OptionalContentConfig::default(),
        );
        painter.set_font("t3", 2.0);
        painter.show_text(&[TextItem::Glyph(glyph(65, 100.0, false)), TextItem::Adjust(500.0)]);
        // 100 glyph units at 0.01 and size 2 is 2; the adjustment of 500 thousandths of size 2 is -1.
        assert!((painter.current.x - 1.0).abs() < 1e-9, "x = {}", painter.current.x);
    }
}
