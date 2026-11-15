//! The page rasteriser: a page drawn to RGBA the way pdf.js draws it on `@napi-rs/canvas` in Node
//! (`page.render({ canvas, canvasContext, viewport, background: 'rgb(255,255,255)' })` of
//! `src/runtime/office/pdf/pdf-render.mjs`), over [`mixdog_raster::canvas::Canvas`] (tiny-skia).
//!
//! The page's operator list ([`crate::oplist::get_operator_list`]) is executed by the painter, pdf.js's `CanvasGraphics`:
//! the white background, the viewport transform, fills and strokes with every line state and dash, clipping (non-zero
//! and even-odd, intersected through `W` and `W*`, the bounding boxes of forms and groups, text clip modes), image
//! XObjects, inline images and image masks (drawn as pdf.js chooses to: halved while oversized, interpolated by the
//! image's `Interpolate` or the output scale, placed on whole pixels when axis aligned), optional content, and text in
//! every rendering mode drawn from glyph outlines supplied through [`FontDrawing`].
//!
//! Cancellation is the document's: the check runs between operators and before each image is decoded, and a cancelled
//! page fails with [`crate::PdfError::Cancelled`]. A page is rendered by one call on one thread; pages are rendered in
//! parallel by calling it from one lane job per page, each with a document opened from the same bytes (a
//! [`Document`] is not shared between threads).
//!
//! The paint stage of the rasteriser (Type3 glyphs, shadings, patterns, soft masks, transparency groups, blend modes
//! beyond the canvas's own) extends the painter; until then those draw nothing, or, for a group, paint in place.

mod images;
mod painter;
mod text;

use mixdog_raster::canvas::Canvas;

use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::oplist::{self, FontProvider, OperatorList};
use crate::page::Page;

pub use self::text::{AccentDraw, DrawnFont, FontDrawing, GlyphDraw};

use self::painter::{OptionalContentConfig, Painter, raster};

/// How a page is rendered.
pub struct RenderOptions<'a> {
    /// The viewport scale (`page.getViewport({ scale })`): pixels per point.
    pub scale: f64,
    /// The fonts of the operator-list pass (`translateFont`); `None` reads a page without text.
    pub fonts: Option<&'a dyn FontProvider>,
    /// The glyph outlines of those fonts; `None` draws no text (said once).
    pub drawing: Option<&'a dyn FontDrawing>,
}

/// A rendered page: the canvas (white background, the page painted on it), its size in pixels.
pub struct RenderedPage {
    pub canvas: Canvas,
}

impl RenderedPage {
    pub fn width(&self) -> u32 {
        self.canvas.width()
    }

    pub fn height(&self) -> u32 {
        self.canvas.height()
    }

    /// The pixels as straight RGBA8 (`getImageData`).
    pub fn rgba(&self) -> Result<Vec<u8>> {
        let data = self
            .canvas
            .get_image_data(0, 0, self.canvas.width(), self.canvas.height())
            .map_err(raster)?;
        Ok(data.into_data())
    }

    /// The page as a PNG file (`canvas.toBuffer('image/png')`).
    pub fn to_png(&self) -> Result<Vec<u8>> {
        self.canvas.to_png().map_err(raster)
    }
}

/// Renders `page`: its operator list, then the list painted.
pub fn render_page(
    document: &Document,
    page: &Page,
    options: &RenderOptions<'_>,
) -> Result<RenderedPage> {
    let list = oplist::get_operator_list(document, page, options.fonts)?;
    render_operator_list(document, page, &list, options)
}

/// Paints an operator list of `page` (the list [`render_page`] reads, or one built by the caller) on a white canvas of
/// the size of the page's viewport at `options.scale` (`Math.ceil` of the viewport's width and height).
pub fn render_operator_list(
    document: &Document,
    page: &Page,
    list: &OperatorList,
    options: &RenderOptions<'_>,
) -> Result<RenderedPage> {
    document.guard().check_now()?;
    let viewport = page.viewport(options.scale);
    let (width, height) = (viewport.width.ceil(), viewport.height.ceil());
    if !(width >= 1.0 && height >= 1.0 && width <= f64::from(u32::MAX) && height <= f64::from(u32::MAX)) {
        return Err(PdfError::Unknown(format!(
            "a page of {width} by {height} pixels cannot be rendered"
        )));
    }
    let mut canvas = Canvas::new(width as u32, height as u32).map_err(raster)?;
    canvas.set_fill_color("rgb(255,255,255)");
    canvas.fill_rect(0.0, 0.0, width as f32, height as f32);
    canvas.set_fill_color("#000000");
    let m = viewport.transform;
    canvas.transform(
        m[0] as f32,
        m[1] as f32,
        m[2] as f32,
        m[3] as f32,
        m[4] as f32,
        m[5] as f32,
    );
    let resources = page.resources(document)?;
    let optional_content = OptionalContentConfig::read(document)?;
    let mut painter = Painter::new(canvas, document, resources, options.drawing, optional_content);
    painter.execute(list)?;
    Ok(RenderedPage {
        canvas: painter.canvas,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::document::OpenOptions;

    /// A one-page PDF whose content stream is `content`.
    fn pdf(media_box: &str, content: &[u8]) -> Vec<u8> {
        let objects: [Vec<u8>; 4] = [
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] /Contents 4 0 R /Resources << >> >>"
            )
            .into_bytes(),
            [
                format!("<< /Length {} >>\nstream\n", content.len()).as_bytes(),
                content,
                b"\nendstream",
            ]
            .concat(),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        out
    }

    fn render(media_box: &str, content: &[u8], scale: f64) -> RenderedPage {
        let document =
            Document::open(pdf(media_box, content), &OpenOptions::default()).expect("the PDF opens");
        let page = document.page(0).expect("page");
        let options = RenderOptions {
            scale,
            fonts: None,
            drawing: None,
        };
        render_page(&document, &page, &options).expect("the page renders")
    }

    fn pixel(page: &RenderedPage, x: u32, y: u32) -> [u8; 4] {
        let rgba = page.rgba().expect("pixels");
        let at = ((y * page.width() + x) * 4) as usize;
        [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
    }

    #[test]
    fn the_page_is_white_and_a_fill_lands_where_the_user_space_puts_it() {
        let page = render("0 0 100 100", b"1 0 0 rg 10 10 50 50 re f", 1.0);
        assert_eq!((page.width(), page.height()), (100, 100));
        assert_eq!(pixel(&page, 5, 5), [255, 255, 255, 255]);
        // User space is y-up: the square covers x 10..60 and device rows 40..90.
        assert_eq!(pixel(&page, 30, 60), [255, 0, 0, 255]);
        assert_eq!(pixel(&page, 30, 20), [255, 255, 255, 255]);
    }

    #[test]
    fn the_size_is_the_ceiling_of_the_viewport() {
        let page = render("0 0 100.5 50", b"", 2.0);
        assert_eq!((page.width(), page.height()), (201, 100));
    }

    #[test]
    fn a_clip_limits_what_follows_and_an_empty_path_clips_nothing() {
        let clipped = render("0 0 100 100", b"20 20 20 20 re W n 0 0 1 rg 0 0 100 100 re f", 1.0);
        assert_eq!(pixel(&clipped, 30, 70), [0, 0, 255, 255]);
        assert_eq!(pixel(&clipped, 60, 70), [255, 255, 255, 255]);
        let unclipped = render("0 0 100 100", b"W n 0 0 1 rg 0 0 100 100 re f", 1.0);
        assert_eq!(pixel(&unclipped, 60, 70), [0, 0, 255, 255]);
    }

    #[test]
    fn even_odd_fill_and_clip_leave_the_inner_square_open() {
        let fill = render(
            "0 0 100 100",
            b"0 1 0 rg 10 10 80 80 re 30 30 40 40 re f*",
            1.0,
        );
        assert_eq!(pixel(&fill, 20, 50), [0, 255, 0, 255]);
        assert_eq!(pixel(&fill, 50, 50), [255, 255, 255, 255]);
        let clip = render(
            "0 0 100 100",
            b"10 10 80 80 re 30 30 40 40 re W* n 0 0 0 rg 0 0 100 100 re f",
            1.0,
        );
        assert_eq!(pixel(&clip, 20, 50), [0, 0, 0, 255]);
        assert_eq!(pixel(&clip, 50, 50), [255, 255, 255, 255]);
    }

    #[test]
    fn a_hairline_is_one_device_pixel_wide_and_a_dash_leaves_gaps() {
        let page = render("0 0 100 100", b"0 w 0 0 0 RG 0 50 m 100 50 l S", 1.0);
        let inked = (0..100).filter(|&y| pixel(&page, 50, y)[0] < 200).count();
        assert!((1..=2).contains(&inked), "{inked} rows inked");
        let dashed = render("0 0 100 100", b"4 w 0 0 0 RG [10 10] 0 d 0 50 m 100 50 l S", 1.0);
        assert_eq!(pixel(&dashed, 5, 50)[0], 0);
        assert_eq!(pixel(&dashed, 15, 50)[0], 255);
        assert_eq!(pixel(&dashed, 25, 50)[0], 0);
    }

    #[test]
    fn a_small_inline_image_is_placed_in_its_unit_square() {
        let mut content = b"q 20 0 0 20 10 10 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ".to_vec();
        content.extend_from_slice(&[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
        content.extend_from_slice(b"\nEI Q");
        let page = render("0 0 100 100", &content, 1.0);
        // The square covers x 10..30 and device rows 70..90; the first image row is the top one.
        assert_eq!(pixel(&page, 15, 75), [255, 0, 0, 255]);
        assert_eq!(pixel(&page, 25, 75), [0, 255, 0, 255]);
        assert_eq!(pixel(&page, 15, 85), [0, 0, 255, 255]);
        assert_eq!(pixel(&page, 25, 85), [255, 255, 255, 255]);
    }

    #[test]
    fn a_cancelled_document_stops_the_render() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let options = OpenOptions {
            cancel: Some(Arc::new(move || flag.load(Ordering::Relaxed))),
            ..OpenOptions::default()
        };
        let document =
            Document::open(pdf("0 0 10 10", b"0 0 5 5 re f"), &options).expect("opens while running");
        let page = document.page(0).expect("page");
        let render_options = RenderOptions {
            scale: 1.0,
            fonts: None,
            drawing: None,
        };
        assert!(render_page(&document, &page, &render_options).is_ok());
        stop.store(true, Ordering::Relaxed);
        assert!(matches!(
            render_page(&document, &page, &render_options),
            Err(PdfError::Cancelled)
        ));
    }
}
