//! Patterns and the `sh` operator: `getColorN_Pattern`, `TilingPattern` and the `getPattern` of the shading patterns
//! (`src/display/pattern_helper.js`), `shadingFill`, and the pattern branches of `fill`, `stroke`, text and image
//! masks (`src/display/canvas.js`).
//!
//! A pattern colour is kept in the graphics state as a [`PatternPaint`]. When something is painted with it, `getPattern`
//! makes the canvas style: a gradient where a shading allows it, otherwise an image the pattern was drawn into (a tile
//! that repeats for a tiling pattern, the rasterised triangles of a mesh, a gradient drawn into the size of the
//! painted shape), positioned with a matrix. A tiling pattern whose tile covers the shape once is instead drawn in
//! place (`drawPattern`).

use std::sync::Arc;

use mixdog_raster::canvas::{Bitmap, Canvas, FillRule, Path2D, PatternStyle, Repetition, Style};

use crate::error::{PdfError, Result};
use crate::oplist::events::{Pattern, ShadingRef, TilingPattern};
use crate::oplist::gstate::{self, Matrix};

use super::painter::{Painter, invert, raster, rect_path, singular_scales, skia, widen};
use super::shading::{Mesh, RadialAxial, ShadingIr, apply_transfer, read_shading};

/// `TilingPattern.MAX_PATTERN_SIZE`.
const MAX_PATTERN_SIZE: f64 = 3000.0;

/// `PathType`: what a pattern is asked for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PathType {
    Fill,
    Stroke,
    Shading,
}

/// A pattern colour (what `setFillColorN` stores in `fillColor`).
pub(super) enum PatternPaint {
    Shading {
        ir: Arc<ShadingIr>,
        /// The pattern's `/Matrix`.
        matrix: Option<Matrix>,
    },
    Tiling(TilingPaint),
}

impl PatternPaint {
    /// `isModifyingCurrentTransform`: a mesh is placed by changing the matrix of the canvas.
    fn is_modifying_current_transform(&self) -> bool {
        matches!(self, PatternPaint::Shading { ir, .. } if matches!(**ir, ShadingIr::Mesh(_)))
    }
}

/// `TilingPattern`.
pub(super) struct TilingPaint {
    cell: TilingPattern,
    /// `this.ctx.canvas`: the size of the canvas the pattern was created on.
    canvas_size: (u32, u32),
    /// `patternBaseMatrix`: the matrix of the page at creation with the pattern's own.
    pattern_base_matrix: Matrix,
}

/// `getSizeAndScale`'s result.
#[derive(Clone, Copy)]
struct Dimension {
    scale: f64,
    size: u32,
}

/// The tile `createPatternCanvas` made and where it goes.
struct TileCanvas {
    canvas: Canvas,
    scale_x: f64,
    scale_y: f64,
    offset_x: f64,
    offset_y: f64,
}

impl TilingPaint {
    fn new(cell: TilingPattern, canvas_size: (u32, u32), base_transform: Matrix) -> Self {
        let pattern_base_matrix = gstate::transform(&base_transform, &cell.matrix);
        Self {
            cell,
            canvas_size,
            pattern_base_matrix,
        }
    }

    /// `canSkipPatternCanvas`: the first tile `[n, m]` when the shape of `dims` (`[width, height, offsetX, offsetY]` in
    /// pattern space) lies within one tile.
    pub(super) fn can_skip_pattern_canvas(&self, dims: [f64; 4]) -> Option<[f64; 2]> {
        let [width, height, offset_x, offset_y] = dims;
        let [x0, y0, x1, y1] = self.cell.bbox;
        let abs_x_step = self.cell.xstep.abs();
        let abs_y_step = self.cell.ystep.abs();
        if width > abs_x_step + 1e-6 || height > abs_y_step + 1e-6 {
            return None;
        }
        let n_x_first = ((offset_x - x1) / abs_x_step).floor() + 1.0;
        let n_x_last = ((offset_x + width - x0) / abs_x_step).ceil() - 1.0;
        let n_y_first = ((offset_y - y1) / abs_y_step).floor() + 1.0;
        let n_y_last = ((offset_y + height - y0) / abs_y_step).ceil() - 1.0;
        (n_x_last <= n_x_first && n_y_last <= n_y_first).then_some([n_x_first, n_y_first])
    }

    /// `updatePatternDims`: the clipped box of the shape in pattern space.
    pub(super) fn update_pattern_dims(&self, clipped: [f64; 4], dims: &mut [f64; 4]) {
        let mut bbox = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        if let Some(inverse) = invert(&self.pattern_base_matrix) {
            super::painter::axial_bounding_box(&clipped, &inverse, &mut bbox);
        }
        dims[0] = bbox[2] - bbox[0];
        dims[1] = bbox[3] - bbox[1];
        dims[2] = bbox[0];
        dims[3] = bbox[1];
    }

    /// `_getCombinedScales`: the scale of the pattern matrix and of the page matrix together.
    fn combined_scales(&self, base_transform: &Matrix) -> (f64, f64) {
        let (matrix_x, matrix_y) = singular_scales(&self.cell.matrix);
        let (base_x, base_y) = singular_scales(base_transform);
        (
            f64::from(((f64::from(matrix_x)) * f64::from(base_x)) as f32),
            f64::from(((f64::from(matrix_y)) * f64::from(base_y)) as f32),
        )
    }

    /// `getSizeAndScale`.
    fn size_and_scale(step: f64, real_output_size: u32, scale: f64) -> Dimension {
        let max_size = MAX_PATTERN_SIZE.max(f64::from(real_output_size));
        let mut size = (step * scale).ceil();
        let mut scale = scale;
        if size >= max_size {
            size = max_size;
        } else {
            scale = size / step;
        }
        Dimension {
            scale,
            size: if size.is_nan() { 0 } else { size as u32 },
        }
    }
}

/// `applyBoundingBox`: the context is clipped to the shading's `/BBox`.
fn apply_bounding_box(ctx: &mut Canvas, bbox: Option<[f64; 4]>) {
    if let Some(b) = bbox {
        ctx.clip_path2d(&rect_path(b[0], b[1], b[2], b[3]), FillRule::Winding);
    }
}

/// The path moved by a matrix (`Path2D.addPath(path, matrix)` into a new path).
pub(super) fn moved(path: &Path2D, m: &Matrix) -> Path2D {
    let mut out = Path2D::new();
    out.add_path(path, skia(m));
    out
}

fn ceil_or_one(extent: f64) -> u32 {
    let size = extent.ceil();
    if size == 0.0 || size.is_nan() {
        1
    } else {
        size as u32
    }
}

impl<'a> Painter<'a> {
    // ---- the colour -----------------------------------------------------------------------------------------------

    /// `setFillColorN` and `setStrokeColorN` of a pattern colour (`getColorN_Pattern`).
    pub(super) fn set_pattern_color(&mut self, pattern: &Pattern, fill: bool) -> Result<()> {
        let paint = match pattern {
            Pattern::Shading { shading, matrix } => PatternPaint::Shading {
                ir: self.shading_ir(shading)?,
                matrix: *matrix,
            },
            Pattern::Tiling(cell) => PatternPaint::Tiling(TilingPaint::new(
                (**cell).clone(),
                (self.canvas.width(), self.canvas.height()),
                self.base_transform,
            )),
        };
        let tiling = matches!(paint, PatternPaint::Tiling(_));
        let paint = Arc::new(paint);
        if fill {
            self.current.fill_pattern = Some(paint);
            self.current.pattern_fill = true;
            self.current.tiling_pattern_dims = tiling.then_some([0.0; 4]);
        } else {
            self.current.stroke_pattern = Some(paint);
            self.current.pattern_stroke = true;
        }
        Ok(())
    }

    /// `_getPattern`'s shading: read once for each id.
    fn shading_ir(&mut self, shading: &ShadingRef) -> Result<Arc<ShadingIr>> {
        if let Some(found) = self.shading_cache.get(&shading.id) {
            return Ok(found.clone());
        }
        let ir = Arc::new(read_shading(self.document, &self.resources, &shading.source)?);
        self.shading_cache.insert(shading.id.clone(), ir.clone());
        Ok(ir)
    }

    /// A pattern that could not be made paints nothing (said once at warn level); a cancellation is not swallowed.
    fn pattern_failed(&mut self, error: PdfError) -> Result<()> {
        if error.is_fatal() {
            return Err(error);
        }
        tracing::warn!("a pattern could not be painted: {}", error.message());
        Ok(())
    }

    // ---- getPattern -----------------------------------------------------------------------------------------------

    /// `getPattern(ctx, owner, inverse, pathType)` on the canvas being painted. The canvas is taken out of the painter
    /// while the pattern is made, so the pattern code works on one canvas and the painter's state alongside it.
    pub(super) fn get_pattern(&mut self, pattern: &PatternPaint, path_type: PathType, inverse: &Matrix) -> Result<Style> {
        let placeholder = Canvas::new(1, 1).map_err(raster)?;
        let mut ctx = std::mem::replace(&mut self.canvas, placeholder);
        let style = self.get_pattern_on(&mut ctx, pattern, path_type, inverse);
        self.canvas = ctx;
        style
    }

    /// `getPattern` with `ctx` the canvas the style is made for.
    pub(super) fn get_pattern_on(
        &self,
        ctx: &mut Canvas,
        pattern: &PatternPaint,
        path_type: PathType,
        inverse: &Matrix,
    ) -> Result<Style> {
        match pattern {
            PatternPaint::Shading { ir, matrix } => match &**ir {
                ShadingIr::RadialAxial(shading) => {
                    self.radial_axial_style(shading, matrix.as_ref(), ctx, path_type, inverse)
                }
                ShadingIr::Mesh(mesh) => self.mesh_style(mesh, matrix.as_ref(), ctx, path_type),
                // `DummyShadingPattern.getPattern`.
                ShadingIr::Dummy => Ok(Style::from_css("hotpink").unwrap_or_default()),
            },
            PatternPaint::Tiling(tiling) => self.tiling_style(tiling, path_type, inverse),
        }
    }

    /// `RadialAxialShadingPattern.getPattern`.
    fn radial_axial_style(
        &self,
        shading: &RadialAxial,
        matrix: Option<&Matrix>,
        ctx: &mut Canvas,
        path_type: PathType,
        inverse: &Matrix,
    ) -> Result<Style> {
        let transfer = self.current.transfer.clone();
        if path_type != PathType::Shading {
            if shading.is_origin_based() && transfer.is_none() {
                let mut transf = gstate::transform(inverse, &self.base_transform);
                if let Some(m) = matrix {
                    transf = gstate::transform(&transf, m);
                }
                let precision = 1e-3;
                let n1 = transf[0].hypot(transf[1]);
                let n2 = transf[2].hypot(transf[3]);
                let ps = (transf[0] * transf[2] + transf[1] * transf[3]) / (n1 * n2);
                if ps.abs() < precision && (!shading.radial || (n1 - n2).abs() < precision) {
                    return Ok(Style::Gradient(shading.create_gradient(Some(&transf))));
                }
            }
            let stroke_transform = widen(ctx.get_transform());
            let owner_bbox = self
                .current
                .clipped_path_bbox((path_type == PathType::Stroke).then_some(&stroke_transform))
                .unwrap_or([0.0; 4]);
            let transform = match matrix {
                Some(m) => gstate::transform(&self.base_transform, m),
                None => self.base_transform,
            };
            return raster_pattern(shading, owner_bbox, &transform, inverse, transfer.as_ref());
        }
        if let Some(maps) = &transfer {
            let clip_box = self.current.clip_box.map(f64::from);
            return raster_pattern(shading, clip_box, &widen(ctx.get_transform()), inverse, Some(maps));
        }
        if shading.are_conic() {
            ctx.save();
            apply_bounding_box(ctx, shading.bbox);
            ctx.set_fill_style(Style::Gradient(shading.create_reversed_gradient(None)));
            ctx.fill_rect(-1e10, -1e10, 2e10, 2e10);
            ctx.restore();
        }
        apply_bounding_box(ctx, shading.bbox);
        Ok(Style::Gradient(shading.create_gradient(None)))
    }

    /// `MeshShadingPattern.getPattern`: the mesh is drawn to an image and the canvas is moved to where the image's
    /// pixels are.
    fn mesh_style(&self, mesh: &Mesh, matrix: Option<&Matrix>, ctx: &mut Canvas, path_type: PathType) -> Result<Style> {
        apply_bounding_box(ctx, mesh.bbox);
        let scale = if path_type == PathType::Shading {
            singular_scales(&widen(ctx.get_transform()))
        } else {
            let (base_x, base_y) = singular_scales(&self.base_transform);
            match matrix {
                Some(m) => {
                    let (matrix_x, matrix_y) = singular_scales(m);
                    (
                        (f64::from(base_x) * f64::from(matrix_x)) as f32,
                        (f64::from(base_y) * f64::from(matrix_y)) as f32,
                    )
                }
                None => (base_x, base_y),
            }
        };
        let background = if path_type == PathType::Shading { None } else { mesh.background };
        let canvas = mesh.create_canvas(scale, background, self.current.transfer.as_ref())?;
        if path_type != PathType::Shading {
            let b = self.base_transform;
            ctx.set_transform(b[0] as f32, b[1] as f32, b[2] as f32, b[3] as f32, b[4] as f32, b[5] as f32);
            if let Some(m) = matrix {
                ctx.transform(m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32, m[4] as f32, m[5] as f32);
            }
        }
        ctx.translate(canvas.offset_x as f32, canvas.offset_y as f32);
        ctx.scale(canvas.scale_x as f32, canvas.scale_y as f32);
        Ok(Style::Pattern(canvas.pattern))
    }

    /// `TilingPattern.getPattern`: the tile as a repeating pattern placed by `matrix`.
    fn tiling_style(&self, tiling: &TilingPaint, path_type: PathType, inverse: &Matrix) -> Result<Style> {
        let matrix = if path_type == PathType::Shading {
            *inverse
        } else {
            gstate::transform(inverse, &tiling.pattern_base_matrix)
        };
        let tile = self.create_pattern_canvas(tiling)?;
        // `new DOMMatrix(matrix).translate(offsetX, offsetY).scale(1 / scaleX, 1 / scaleY)`.
        let placed = gstate::transform(&matrix, &[1.0, 0.0, 0.0, 1.0, tile.offset_x, tile.offset_y]);
        let placed = gstate::transform(&placed, &[1.0 / tile.scale_x, 0.0, 0.0, 1.0 / tile.scale_y, 0.0, 0.0]);
        let mut pattern = PatternStyle::new(&Bitmap::from_canvas(&tile.canvas), Repetition::Repeat);
        pattern.set_transform(
            placed[0] as f32,
            placed[1] as f32,
            placed[2] as f32,
            placed[3] as f32,
            placed[4] as f32,
            placed[5] as f32,
        );
        Ok(Style::Pattern(pattern))
    }

    /// `createPatternCanvas`: a tile of the pattern's step, made of the cell drawn more than once when the step is
    /// smaller than the cell's box.
    fn create_pattern_canvas(&self, tiling: &TilingPaint) -> Result<TileCanvas> {
        let [x0, y0, x1, y1] = tiling.cell.bbox;
        let (width, height) = (x1 - x0, y1 - y0);
        let xstep = tiling.cell.xstep.abs();
        let ystep = tiling.cell.ystep.abs();
        let (scale_x, scale_y) = tiling.combined_scales(&self.base_transform);
        let (mut canvas_width, mut canvas_height) = (width, height);
        let (mut redraw_horizontally, mut redraw_vertically) = (false, false);
        if (xstep * scale_x).ceil() >= (width * scale_x).ceil() {
            canvas_width = xstep;
        } else {
            redraw_horizontally = true;
        }
        if (ystep * scale_y).ceil() >= (height * scale_y).ceil() {
            canvas_height = ystep;
        } else {
            redraw_vertically = true;
        }
        let (out_width, out_height) = tiling.canvas_size;
        let dimx = TilingPaint::size_and_scale(canvas_width, out_width, scale_x);
        let dimy = TilingPaint::size_and_scale(canvas_height, out_height, scale_y);
        let tile = self.render_tile_canvas(tiling, dimx, dimy)?;
        if !(redraw_horizontally || redraw_vertically) {
            return Ok(TileCanvas {
                canvas: tile,
                scale_x: dimx.scale,
                scale_y: dimy.scale,
                offset_x: x0,
                offset_y: y0,
            });
        }
        if redraw_horizontally {
            canvas_width = xstep;
        }
        if redraw_vertically {
            canvas_height = ystep;
        }
        let dimx2 = TilingPaint::size_and_scale(canvas_width, out_width, scale_x);
        let dimy2 = TilingPaint::size_and_scale(canvas_height, out_height, scale_y);
        let (x_size, y_size) = (dimx2.size, dimy2.size);
        let mut second = Canvas::new(x_size, y_size).map_err(raster)?;
        let image_width = tile.width();
        let ii = if redraw_horizontally {
            (width / xstep).floor().min((f64::from(image_width) / f64::from(x_size)).ceil())
        } else {
            0.0
        };
        let jj = if redraw_vertically {
            (height / ystep).floor().min((f64::from(tile.height()) / f64::from(y_size)).ceil())
        } else {
            0.0
        };
        let image = Bitmap::from_canvas(&tile);
        let mut row_source = image.clone();
        if redraw_vertically {
            let mut band = Canvas::new(image_width, y_size).map_err(raster)?;
            let mut j = jj as i64;
            while j >= 0 {
                band.draw_image_region(
                    &image,
                    0.0,
                    (y_size as i64 * j) as f32,
                    image_width as f32,
                    y_size as f32,
                    0.0,
                    0.0,
                    image_width as f32,
                    y_size as f32,
                );
                j -= 1;
            }
            row_source = Bitmap::from_canvas(&band);
        }
        let mut i = ii as i64;
        while i >= 0 {
            second.draw_image_region(
                &row_source,
                (x_size as i64 * i) as f32,
                0.0,
                x_size as f32,
                y_size as f32,
                0.0,
                0.0,
                x_size as f32,
                y_size as f32,
            );
            i -= 1;
        }
        Ok(TileCanvas {
            canvas: second,
            scale_x: dimx2.scale,
            scale_y: dimy2.scale,
            offset_x: x0,
            offset_y: y0,
        })
    }

    /// `_renderTileCanvas`: the pattern cell executed on a canvas of `dimx.size` by `dimy.size` pixels.
    fn render_tile_canvas(&self, tiling: &TilingPaint, dimx: Dimension, dimy: Dimension) -> Result<Canvas> {
        let [x0, y0, x1, y1] = tiling.cell.bbox;
        let canvas = Canvas::new(dimx.size.max(1), dimy.size.max(1)).map_err(raster)?;
        let mut graphics = self.nested(canvas);
        graphics.current.transfer = self.current.transfer.clone();
        graphics.set_tile_colors(&tiling.cell);
        graphics.canvas.translate((-dimx.scale * x0) as f32, (-dimy.scale * y0) as f32);
        graphics.canvas.transform(dimx.scale as f32, 0.0, 0.0, dimy.scale as f32, 0.0, 0.0);
        graphics.canvas.save();
        graphics.clip_bbox(x0, y0, x1, y1);
        graphics.base_transform = widen(graphics.canvas.get_transform());
        graphics.execute(&tiling.cell.operator_list)?;
        Ok(graphics.into_base_canvas())
    }

    /// `setFillAndStrokeStyleToContext`: a coloured pattern paints in black until it sets its own colours, an
    /// uncoloured one in the colour the pattern was selected with.
    fn set_tile_colors(&mut self, cell: &TilingPattern) {
        let color = if cell.paint_type == 2 {
            cell.color.clone().unwrap_or_else(|| "#000000".to_owned())
        } else {
            "#000000".to_owned()
        };
        self.set_fill_color(&color);
        self.set_stroke_color(&color);
        self.current.fill_pattern = None;
        self.current.stroke_pattern = None;
        self.current.tiling_pattern_dims = None;
    }

    /// `clipBbox`: the cell's box clips the tile and is the box of what is painted.
    fn clip_bbox(&mut self, x0: f64, y0: f64, x1: f64, y1: f64) {
        let clip = rect_path(x0, y0, x1, y1);
        let m = self.ctm();
        let mut min_max = self.current.min_max.map(f64::from);
        super::painter::axial_bounding_box(&[x0, y0, x1, y1], &m, &mut min_max);
        self.current.min_max = min_max.map(|v| v as f32);
        self.canvas.clip_path2d(&clip, FillRule::Winding);
        self.current.update_clip_from_path();
    }

    // ---- painting -------------------------------------------------------------------------------------------------

    /// `drawPattern`: a tiling pattern drawn straight into the page, clipped to the shape, for the tile `[n, m]`.
    fn draw_tiling_pattern(&mut self, tiling: &TilingPaint, path: &Path2D, even_odd: bool, tile: [f64; 2]) -> Result<()> {
        let [x0, y0, x1, y1] = tiling.cell.bbox;
        self.save();
        self.canvas
            .clip_path2d(path, if even_odd { FillRule::EvenOdd } else { FillRule::Winding });
        let b = tiling.pattern_base_matrix;
        self.canvas
            .set_transform(b[0] as f32, b[1] as f32, b[2] as f32, b[3] as f32, b[4] as f32, b[5] as f32);
        self.canvas
            .translate((tile[0] * tiling.cell.xstep) as f32, (tile[1] * tiling.cell.ystep) as f32);
        let isolated = tiling.cell.needs_isolation
            || self.canvas.global_alpha() != 1.0
            || self.current.blend_mode != "source-over"
            || self.current.active_smask.is_some();
        let outcome = if isolated {
            let (box_width, box_height) = (x1 - x0, y1 - y0);
            let (scale_x, scale_y) = tiling.combined_scales(&self.base_transform);
            let dimx = TilingPaint::size_and_scale(box_width, tiling.canvas_size.0, scale_x);
            let dimy = TilingPaint::size_and_scale(box_height, tiling.canvas_size.1, scale_y);
            self.render_tile_canvas(tiling, dimx, dimy).map(|tile_canvas| {
                self.canvas.draw_image_scaled(
                    &Bitmap::from_canvas(&tile_canvas),
                    x0 as f32,
                    y0 as f32,
                    box_width as f32,
                    box_height as f32,
                );
            })
        } else {
            self.set_tile_colors(&tiling.cell);
            self.clip_bbox(x0, y0, x1, y1);
            self.base_transform_stack.push(self.base_transform);
            self.base_transform = self.ctm();
            let result = self.execute(&tiling.cell.operator_list);
            self.base_transform = self.base_transform_stack.pop().unwrap_or(self.base_transform);
            result
        };
        self.restore();
        outcome
    }

    /// The pattern branch of `fill`: the shape painted with the fill pattern.
    pub(super) fn fill_with_pattern(&mut self, path: &Path2D, rule: FillRule) -> Result<()> {
        let Some(pattern) = self.current.fill_pattern.clone() else {
            return Ok(());
        };
        let intersect = self.current.clipped_path_bbox(None);
        if let PatternPaint::Tiling(tiling) = &*pattern
            && let Some(dims) = self.current.tiling_pattern_dims
            && let Some(tile) = tiling.can_skip_pattern_canvas(dims)
        {
            let outcome = self.draw_tiling_pattern(tiling, path, rule == FillRule::EvenOdd, tile);
            self.current.tiling_pattern_dims = None;
            return outcome;
        }
        let modifying = pattern.is_modifying_current_transform();
        let before = self.ctm();
        self.canvas.save();
        let Some(inverse) = invert(&before) else {
            self.canvas.restore();
            return Ok(());
        };
        let style = match self.get_pattern(&pattern, PathType::Fill, &inverse) {
            Ok(style) => style,
            Err(error) => {
                self.canvas.restore();
                return self.pattern_failed(error);
            }
        };
        self.canvas.set_fill_style(style);
        let path = if modifying {
            match invert(&self.ctm()) {
                Some(now) => moved(path, &gstate::transform(&now, &before)),
                None => path.clone(),
            }
        } else {
            path.clone()
        };
        if self.content_visible && intersect.is_some() {
            self.canvas.fill_path2d(&path, rule);
        }
        self.canvas.restore();
        Ok(())
    }

    /// The pattern branch of `stroke`: the outline painted with the stroke pattern.
    pub(super) fn stroke_with_pattern(&mut self, path: &Path2D) -> Result<()> {
        let Some(pattern) = self.current.stroke_pattern.clone() else {
            return Ok(());
        };
        let modifying = pattern.is_modifying_current_transform();
        let before = self.ctm();
        self.canvas.save();
        let Some(inverse) = invert(&before) else {
            self.canvas.restore();
            return Ok(());
        };
        let style = match self.get_pattern(&pattern, PathType::Stroke, &inverse) {
            Ok(style) => style,
            Err(error) => {
                self.canvas.restore();
                return self.pattern_failed(error);
            }
        };
        self.canvas.set_stroke_style(style);
        let path = if modifying {
            match invert(&self.ctm()) {
                Some(now) => moved(path, &gstate::transform(&now, &before)),
                None => path.clone(),
            }
        } else {
            path.clone()
        };
        self.rescale_and_stroke(&path);
        self.canvas.restore();
        Ok(())
    }

    /// The pattern of a text fill or stroke (`showText`): the style is set on the canvas and the matrix the pattern
    /// was made for is returned, so the glyphs can be drawn in it.
    pub(super) fn text_pattern(&mut self, fill: bool) -> Result<Option<Matrix>> {
        let pattern = if fill {
            self.current.fill_pattern.clone()
        } else {
            self.current.stroke_pattern.clone()
        };
        let Some(pattern) = pattern else {
            return Ok(None);
        };
        let Some(inverse) = invert(&self.ctm()) else {
            return Ok(None);
        };
        let path_type = if fill { PathType::Fill } else { PathType::Stroke };
        self.canvas.save();
        let style = self.get_pattern(&pattern, path_type, &inverse);
        let transform = widen(self.canvas.get_transform());
        self.canvas.restore();
        match style {
            Ok(style) => {
                if fill {
                    self.canvas.set_fill_style(style);
                } else {
                    self.canvas.set_stroke_style(style);
                }
                Ok(Some(transform))
            }
            Err(error) => self.pattern_failed(error).map(|()| None),
        }
    }

    /// The fill pattern as a style for an image mask drawn on its own canvas (`_createMaskCanvas`): the pattern is
    /// made for `inverse`, the matrix from that canvas to the pattern's space.
    pub(super) fn mask_pattern_style(&mut self, inverse: &Matrix) -> Result<Option<Style>> {
        let Some(pattern) = self.current.fill_pattern.clone() else {
            return Ok(None);
        };
        // A mesh moves the canvas it is made for; here that is a scratch one.
        let mut scratch = Canvas::new(1, 1).map_err(raster)?;
        match self.get_pattern_on(&mut scratch, &pattern, PathType::Fill, inverse) {
            Ok(style) => Ok(Some(style)),
            Err(error) => self.pattern_failed(error).map(|()| None),
        }
    }

    /// `shadingFill` (`sh`): the shading painted over the whole clip.
    pub(super) fn shading_fill(&mut self, shading: &ShadingRef) -> Result<()> {
        if !self.content_visible {
            return Ok(());
        }
        self.save();
        let outcome = self.paint_shading(shading);
        self.restore();
        outcome
    }

    fn paint_shading(&mut self, shading: &ShadingRef) -> Result<()> {
        let ir = self.shading_ir(shading)?;
        let pattern = PatternPaint::Shading { ir, matrix: None };
        let inverse = invert(&self.ctm()).unwrap_or(gstate::IDENTITY);
        match self.get_pattern(&pattern, PathType::Shading, &inverse) {
            Ok(style) => self.canvas.set_fill_style(style),
            Err(error) => return self.pattern_failed(error),
        }
        match invert(&self.ctm()) {
            Some(inverse) => {
                let (width, height) = (f64::from(self.canvas.width()), f64::from(self.canvas.height()));
                let mut min_max = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
                super::painter::axial_bounding_box(&[0.0, 0.0, width, height], &inverse, &mut min_max);
                self.canvas.fill_rect(
                    min_max[0] as f32,
                    min_max[1] as f32,
                    (min_max[2] - min_max[0]) as f32,
                    (min_max[3] - min_max[1]) as f32,
                );
            }
            None => self.canvas.fill_rect(-1e10, -1e10, 2e10, 2e10),
        }
        Ok(())
    }
}

/// `_createRasterPattern`: the gradient drawn into an image of the size of `bbox` (the shape that is painted), used as
/// a pattern that does not repeat.
fn raster_pattern(
    shading: &RadialAxial,
    bbox: [f64; 4],
    transform: &Matrix,
    inverse: &Matrix,
    transfer: Option<&super::painter::TransferMaps>,
) -> Result<Style> {
    let width = ceil_or_one(bbox[2] - bbox[0]);
    let height = ceil_or_one(bbox[3] - bbox[1]);
    let mut canvas = Canvas::new(width, height).map_err(raster)?;
    canvas.begin_path();
    canvas.rect(0.0, 0.0, width as f32, height as f32);
    canvas.translate(-bbox[0] as f32, -bbox[1] as f32);
    let inverse = gstate::transform(inverse, &[1.0, 0.0, 0.0, 1.0, bbox[0], bbox[1]]);
    canvas.transform(
        transform[0] as f32,
        transform[1] as f32,
        transform[2] as f32,
        transform[3] as f32,
        transform[4] as f32,
        transform[5] as f32,
    );
    apply_bounding_box(&mut canvas, shading.bbox);
    if shading.are_conic() {
        canvas.set_fill_style(Style::Gradient(shading.create_reversed_gradient(None)));
        canvas.fill(FillRule::Winding);
    }
    canvas.set_fill_style(Style::Gradient(shading.create_gradient(None)));
    canvas.fill(FillRule::Winding);
    if let Some(maps) = transfer {
        apply_transfer(&mut canvas, maps)?;
    }
    let mut pattern = PatternStyle::new(&Bitmap::from_canvas(&canvas), Repetition::NoRepeat);
    pattern.set_transform(
        inverse[0] as f32,
        inverse[1] as f32,
        inverse[2] as f32,
        inverse[3] as f32,
        inverse[4] as f32,
        inverse[5] as f32,
    );
    Ok(Style::Pattern(pattern))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oplist::OperatorList;

    fn tiling(bbox: [f64; 4], xstep: f64, ystep: f64) -> TilingPaint {
        TilingPaint::new(
            TilingPattern {
                color: None,
                operator_list: Arc::new(OperatorList::new()),
                matrix: gstate::IDENTITY,
                bbox,
                xstep,
                ystep,
                paint_type: 1,
                tiling_type: 1,
                needs_isolation: false,
            },
            (100, 100),
            gstate::IDENTITY,
        )
    }

    #[test]
    fn a_shape_within_one_tile_skips_the_pattern_canvas() {
        let cell = tiling([0.0, 0.0, 10.0, 10.0], 10.0, 10.0);
        // 4 by 4 at (12, 3): inside the tile one step to the right.
        assert_eq!(cell.can_skip_pattern_canvas([4.0, 4.0, 12.0, 3.0]), Some([1.0, 0.0]));
        // Wider than a step.
        assert_eq!(cell.can_skip_pattern_canvas([11.0, 4.0, 0.0, 0.0]), None);
        // Straddling two tiles.
        assert_eq!(cell.can_skip_pattern_canvas([4.0, 4.0, 8.0, 3.0]), None);
    }

    #[test]
    fn the_dims_of_a_shape_are_taken_in_pattern_space() {
        let mut cell = tiling([0.0, 0.0, 10.0, 10.0], 10.0, 10.0);
        cell.pattern_base_matrix = [2.0, 0.0, 0.0, 2.0, 10.0, 0.0];
        let mut dims = [0.0; 4];
        cell.update_pattern_dims([10.0, 0.0, 30.0, 20.0], &mut dims);
        assert_eq!(dims, [10.0, 10.0, 0.0, 0.0]);
    }

    #[test]
    fn a_tile_is_as_big_as_the_scale_makes_it_unless_it_is_huge() {
        let small = TilingPaint::size_and_scale(10.0, 100, 2.5);
        assert_eq!(small.size, 25);
        assert!((small.scale - 2.5).abs() < 1e-12);
        let huge = TilingPaint::size_and_scale(10.0, 100, 1000.0);
        assert_eq!(huge.size, 3000);
        assert_eq!(huge.scale, 1000.0, "a tile cut to the largest size keeps the scale asked for");
        let fractional = TilingPaint::size_and_scale(10.0, 100, 0.33);
        assert_eq!(fractional.size, 4);
        assert!((fractional.scale - 0.4).abs() < 1e-12);
    }
}
