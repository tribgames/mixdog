//! Images on the page: `paintImageXObject`, `paintInlineImageXObject` and `paintImageMaskXObject` of pdf.js's
//! `src/display/canvas.js` with their helpers (`_scaleImage`, `drawImageAtIntegerCoords`,
//! `getImageSmoothingEnabled`, `_createMaskCanvas`). The pixels come from [`crate::image`], which decodes the image
//! as pdf.js's evaluator does; this file draws them.
//!
//! An image is drawn in the unit square of the matrix in force: it is scaled by 1 / width and -1 / height first, halved
//! while it is more than twice the size it lands in (`_scaleImage`), and drawn with interpolation when the image asks
//! for it or is not magnified past the output scale. An axis-aligned image lands on whole pixels
//! (`drawImageAtIntegerCoords`). An image mask is drawn into a canvas of its own, filled with the fill colour through
//! `source-in`, and that canvas is placed on the page.

use mixdog_raster::canvas::{Bitmap, Canvas};

use crate::error::Result;
use crate::image::{self, ImageData, ImageMask, StencilMask};
use crate::oplist::events::{ImageRef, InlineImage};
use crate::oplist::gstate::{self, Matrix};

use super::painter::{Painter, axial_bounding_box, invert, js_round, js_sign, raster, singular_scales, widen};

/// `PixelsPerInch.PDF_TO_CSS_UNITS` as the single-precision `actualScale` of `getImageSmoothingEnabled`.
const ACTUAL_SCALE: f32 = 96.0 / 72.0;

/// `getImageSmoothingEnabled`.
fn smoothing_enabled(transform: &Matrix, interpolate: Option<bool>) -> bool {
    if interpolate == Some(true) {
        return true;
    }
    let (x, y) = singular_scales(transform);
    x <= ACTUAL_SCALE && y <= ACTUAL_SCALE
}

/// An image that is smaller than the one painted from it, and its size.
struct Scaled {
    bitmap: Bitmap,
    width: u32,
    height: u32,
}

/// `_scaleImage`: the image halved (in the dimension that is more than twice too big) until it is within twice the
/// size of `inverse`'s unit square.
fn scale_image(image: Bitmap, inverse: &Matrix) -> Result<Scaled> {
    let (width, height) = (image.width(), image.height());
    let mut width_scale = inverse[0].hypot(inverse[1]).max(1.0);
    let mut height_scale = inverse[2].hypot(inverse[3]).max(1.0);
    let (mut painted_width, mut painted_height) = (width, height);
    let mut source = image;
    while (width_scale > 2.0 && painted_width > 1) || (height_scale > 2.0 && painted_height > 1) {
        let (mut next_width, mut next_height) = (painted_width, painted_height);
        if width_scale > 2.0 && painted_width > 1 {
            next_width = painted_width.div_ceil(2);
            width_scale /= f64::from(painted_width) / f64::from(next_width);
        }
        if height_scale > 2.0 && painted_height > 1 {
            next_height = painted_height.div_ceil(2);
            height_scale /= f64::from(painted_height) / f64::from(next_height);
        }
        let mut step = Canvas::new(next_width, next_height).map_err(raster)?;
        step.draw_image_region(
            &source,
            0.0,
            0.0,
            painted_width as f32,
            painted_height as f32,
            0.0,
            0.0,
            next_width as f32,
            next_height as f32,
        );
        source = Bitmap::from_canvas(&step);
        painted_width = next_width;
        painted_height = next_height;
    }
    Ok(Scaled {
        bitmap: source,
        width: painted_width,
        height: painted_height,
    })
}

/// `drawImageAtIntegerCoords`: `(sx, sy, sw, sh)` of `source` into `(dx, dy, dw, dh)` of the current user space; an
/// image under a matrix without rotation (or with a quarter turn) goes to whole device pixels.
fn draw_at_integer_coords(
    canvas: &mut Canvas,
    source: &Bitmap,
    (sx, sy, sw, sh): (f32, f32, f32, f32),
    (dx, dy, dw, dh): (f64, f64, f64, f64),
) {
    let [a, b, c, d, tx, ty] = widen(canvas.get_transform());
    let restore = |canvas: &mut Canvas| {
        canvas.set_transform(a as f32, b as f32, c as f32, d as f32, tx as f32, ty as f32);
    };
    if b == 0.0 && c == 0.0 {
        let left = js_round(dx * a + tx);
        let top = js_round(dy * d + ty);
        let right = (dx + dw) * a + tx;
        let width = nonzero((js_round(right) - left).abs());
        let bottom = (dy + dh) * d + ty;
        let height = nonzero((js_round(bottom) - top).abs());
        canvas.set_transform(js_sign(a) as f32, 0.0, 0.0, js_sign(d) as f32, left as f32, top as f32);
        canvas.draw_image_region(source, sx, sy, sw, sh, 0.0, 0.0, width as f32, height as f32);
        restore(canvas);
    } else if a == 0.0 && d == 0.0 {
        let left = js_round(dy * c + tx);
        let top = js_round(dx * b + ty);
        let right = (dy + dh) * c + tx;
        let width = nonzero((js_round(right) - left).abs());
        let bottom = (dx + dw) * b + ty;
        let height = nonzero((js_round(bottom) - top).abs());
        canvas.set_transform(0.0, js_sign(b) as f32, js_sign(c) as f32, 0.0, left as f32, top as f32);
        canvas.draw_image_region(source, sx, sy, sw, sh, 0.0, 0.0, height as f32, width as f32);
        restore(canvas);
    } else {
        canvas.draw_image_region(source, sx, sy, sw, sh, dx as f32, dy as f32, dw as f32, dh as f32);
    }
}

/// `x || 1`.
fn nonzero(value: f64) -> f64 {
    if value == 0.0 || value.is_nan() { 1.0 } else { value }
}

/// An image stream with no `Subtype` is the body of an inline image (`BI ... EI`): its keys may be the abbreviations.
fn is_inline(source: &crate::stream::PdfStream) -> bool {
    !source.dict.has("Subtype")
}

/// The opaque black of a mask pixel that paints and the transparency of one that does not: a clear bit paints
/// (`convertBlackAndWhiteToRGBA` with a zero `nonBlackColor`).
fn mask_pixels(mask: &ImageMask) -> Vec<u8> {
    let stride = mask.width.div_ceil(8);
    let mut rgba = Vec::with_capacity(mask.width * mask.height * 4);
    for y in 0..mask.height {
        for x in 0..mask.width {
            let byte = mask.data.get(y * stride + x / 8).copied().unwrap_or(255);
            let paints = byte >> (7 - x % 8) & 1 == 0;
            rgba.extend_from_slice(&[0, 0, 0, if paints { 255 } else { 0 }]);
        }
    }
    rgba
}

impl Painter<'_> {
    /// `paintImageXObject`: the image the stream is.
    pub(super) fn paint_image_object(&mut self, image: &ImageRef) -> Result<()> {
        self.document.guard().check_now()?;
        let resources = self.resources.clone();
        let inline = is_inline(&image.source);
        let decoded = image::decode_image(
            self.document.xref(),
            inline.then_some(&*resources),
            &image.source,
            inline,
        );
        self.paint_decoded(decoded)
    }

    /// `paintInlineImageXObject` of a small inline image.
    pub(super) fn paint_small_inline_image(&mut self, image: &InlineImage) -> Result<()> {
        self.document.guard().check_now()?;
        let resources = self.resources.clone();
        let decoded = image::decode_small_inline_image(
            self.document.xref(),
            Some(&*resources),
            &image.source,
        );
        self.paint_decoded(decoded)
    }

    /// An image that cannot be decoded is left out (pdf.js reports it and goes on); a cancellation or a limit is not
    /// swallowed.
    fn paint_decoded(&mut self, decoded: Result<ImageData>) -> Result<()> {
        match decoded {
            Ok(data) => self.paint_image_data(&data),
            Err(error) if error.is_fatal() => Err(error),
            Err(error) => {
                tracing::warn!("Unable to paint an image: {}", error.message());
                Ok(())
            }
        }
    }

    /// `paintInlineImageXObject(imgData)`: the pixels drawn into the unit square.
    fn paint_image_data(&mut self, data: &ImageData) -> Result<()> {
        let (width, height) = (data.width, data.height);
        if width == 0 || height == 0 {
            return Ok(());
        }
        let mut rgba = data.to_rgba();
        if let Some(maps) = &self.current.transfer {
            maps.apply_to_rgba(&mut rgba);
        }
        let Ok(bitmap) = Bitmap::from_straight(width as u32, height as u32, &rgba) else {
            tracing::warn!("Unable to paint an image of {width} by {height} pixels");
            return Ok(());
        };
        self.save();
        self.canvas.scale(1.0 / width as f32, -1.0 / height as f32);
        let result = self.draw_unit_image(bitmap, data.interpolate);
        self.restore();
        result
    }

    fn draw_unit_image(&mut self, bitmap: Bitmap, interpolate: Option<bool>) -> Result<()> {
        let (width, height) = (f64::from(bitmap.width()), f64::from(bitmap.height()));
        let transform = self.ctm();
        let Some(inverse) = invert(&transform) else {
            return Ok(());
        };
        let scaled = scale_image(bitmap, &inverse)?;
        self.canvas
            .set_image_smoothing_enabled(smoothing_enabled(&transform, interpolate));
        draw_at_integer_coords(
            &mut self.canvas,
            &scaled.bitmap,
            (0.0, 0.0, scaled.width as f32, scaled.height as f32),
            (0.0, -height, width, height),
        );
        Ok(())
    }

    /// `paintImageMaskXObject`: the stencil of the stream painted in the fill colour.
    pub(super) fn paint_image_mask_object(&mut self, image: &ImageRef) -> Result<()> {
        self.document.guard().check_now()?;
        let mask = match image::decode_image_mask(self.document.xref(), &image.source) {
            Ok(StencilMask::Mask(mask)) => mask,
            Ok(StencilMask::SingleOpaquePixel) => {
                self.canvas.fill_rect(0.0, 0.0, 1.0, 1.0);
                return Ok(());
            }
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => {
                tracing::warn!("Unable to paint an image mask: {}", error.message());
                return Ok(());
            }
        };
        if mask.width == 0 || mask.height == 0 {
            return Ok(());
        }
        self.paint_image_mask(&mask)
    }

    /// `_createMaskCanvas` and the draw of `paintImageMaskXObject`.
    fn paint_image_mask(&mut self, mask: &ImageMask) -> Result<()> {
        if self.current.pattern_fill {
            self.report_once("pattern", "an image mask painted with a pattern is drawn by the paint stage of the rasteriser");
            return Ok(());
        }
        let (width, height) = (mask.width as f64, mask.height as f64);
        let Ok(stencil) = Bitmap::from_straight(mask.width as u32, mask.height as u32, &mask_pixels(mask)) else {
            tracing::warn!("Unable to paint an image mask of {} by {} pixels", mask.width, mask.height);
            return Ok(());
        };
        let current = self.ctm();
        let mut to_canvas = gstate::transform(&current, &[1.0 / width, 0.0, 0.0, -1.0 / height, 0.0, 0.0]);
        to_canvas = gstate::transform(&to_canvas, &[1.0, 0.0, 0.0, 1.0, 0.0, -height]);
        let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        axial_bounding_box(&[0.0, 0.0, width, height], &to_canvas, &mut bounds);
        let drawn_width = nonzero(js_round(bounds[2] - bounds[0]));
        let drawn_height = nonzero(js_round(bounds[3] - bounds[1]));
        let Ok(mut fill) = Canvas::new(drawn_width as u32, drawn_height as u32) else {
            tracing::warn!("Unable to paint an image mask that covers {drawn_width} by {drawn_height} pixels");
            return Ok(());
        };
        fill.translate(-bounds[0] as f32, -bounds[1] as f32);
        fill.transform(
            to_canvas[0] as f32,
            to_canvas[1] as f32,
            to_canvas[2] as f32,
            to_canvas[3] as f32,
            to_canvas[4] as f32,
            to_canvas[5] as f32,
        );
        let fill_transform = widen(fill.get_transform());
        let Some(inverse) = invert(&fill_transform) else {
            return Ok(());
        };
        let scaled = scale_image(stencil, &inverse)?;
        fill.set_image_smoothing_enabled(smoothing_enabled(&fill_transform, mask.interpolate));
        draw_at_integer_coords(
            &mut fill,
            &scaled.bitmap,
            (0.0, 0.0, scaled.width as f32, scaled.height as f32),
            (0.0, 0.0, width, height),
        );
        fill.set_global_composite_operation("source-in");
        fill.set_fill_style(self.canvas.fill_style().clone());
        fill.fill_rect(0.0, 0.0, width as f32, height as f32);
        let placed = Bitmap::from_canvas(&fill);
        self.canvas.save();
        self.canvas.set_transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        self.canvas
            .draw_image(&placed, js_round(bounds[0]) as f32, js_round(bounds[1]) as f32);
        self.canvas.restore();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(width: u32, height: u32, rgba: [u8; 4]) -> Bitmap {
        let pixels: Vec<u8> = (0..width * height).flat_map(|_| rgba).collect();
        Bitmap::from_straight(width, height, &pixels).expect("bitmap")
    }

    fn red(canvas: &Canvas, x: i32, y: i32) -> u8 {
        canvas.get_image_data(x, y, 1, 1).expect("pixel").data()[0]
    }

    #[test]
    fn a_big_image_is_halved_until_it_is_within_twice_its_size() {
        let scaled = scale_image(opaque(64, 32, [10, 20, 30, 255]), &[8.0, 0.0, 0.0, 1.0, 0.0, 0.0]).expect("scaled");
        // 64 wide landing in 8: halved 64 -> 32 -> 16, where the remaining scale is 2.
        assert_eq!((scaled.width, scaled.height), (16, 32));
        let same = scale_image(opaque(4, 4, [0, 0, 0, 255]), &[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]).expect("same");
        assert_eq!((same.width, same.height), (4, 4));
    }

    #[test]
    fn smoothing_follows_interpolate_and_the_scale() {
        assert!(smoothing_enabled(&[100.0, 0.0, 0.0, 100.0, 0.0, 0.0], Some(true)));
        assert!(!smoothing_enabled(&[100.0, 0.0, 0.0, 100.0, 0.0, 0.0], None));
        assert!(smoothing_enabled(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0], None));
        assert!(smoothing_enabled(&[1.3, 0.0, 0.0, 1.3, 0.0, 0.0], Some(false)));
    }

    #[test]
    fn an_axis_aligned_image_lands_on_whole_pixels() {
        let mut canvas = Canvas::new(20, 20).expect("canvas");
        canvas.set_image_smoothing_enabled(false);
        canvas.transform(1.0, 0.0, 0.0, 1.0, 2.4, 3.4);
        draw_at_integer_coords(
            &mut canvas,
            &opaque(2, 2, [200, 0, 0, 255]),
            (0.0, 0.0, 2.0, 2.0),
            (0.0, 0.0, 4.4, 4.4),
        );
        // The corner (2.4, 3.4) rounds to (2, 3) and the far corner (6.8, 7.8) to (7, 8): 5 by 5 whole pixels.
        assert_eq!(red(&canvas, 2, 3), 200);
        assert_eq!(red(&canvas, 6, 7), 200);
        assert_eq!(red(&canvas, 7, 7), 0);
        assert_eq!(red(&canvas, 2, 2), 0);
        assert_eq!(canvas.get_transform(), [1.0, 0.0, 0.0, 1.0, 2.4, 3.4]);
    }

    #[test]
    fn a_clear_bit_of_a_mask_paints() {
        let mask = ImageMask {
            width: 3,
            height: 1,
            interpolate: None,
            data: vec![0b0100_0000],
        };
        let rgba = mask_pixels(&mask);
        let alphas: Vec<u8> = rgba.chunks(4).map(|pixel| pixel[3]).collect();
        assert_eq!(alphas, vec![255, 0, 255]);
    }
}
