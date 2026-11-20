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
//! Beyond paths, images and text, the painter draws what pdf.js draws with the rest of its display layer: Type3 glyph
//! procedures (`text.rs`), shadings of every type and the `sh` operator (`shading.rs`), tiling and shading patterns
//! as fill, stroke, text and image mask colours (`pattern.rs`), and transparency groups, soft masks, constant alpha
//! and blend modes (`transparency.rs`). Two things pdf.js does are not done: knockout groups paint as ordinary groups,
//! and a non-isolated group does not take a copy of its backdrop with it.

mod images;
mod painter;
mod pattern;
mod shading;
mod text;
mod transparency;

use mixdog_raster::canvas::Canvas;

use std::collections::HashMap;
use std::sync::Arc;

use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::oplist::{self, FontHandle, FontProvider, OperatorList};
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
        let data = self.canvas.get_image_data(0, 0, self.canvas.width(), self.canvas.height()).map_err(raster)?;
        Ok(data.into_data())
    }

    /// The page as a PNG file (`canvas.toBuffer('image/png')`).
    pub fn to_png(&self) -> Result<Vec<u8>> {
        self.canvas.to_png().map_err(raster)
    }
}

/// Renders `page`: its operator list, then the list painted.
pub fn render_page(document: &Document, page: &Page, options: &RenderOptions<'_>) -> Result<RenderedPage> {
    let operators = oplist::get_page_operators(document, page, options.fonts)?;
    paint_operator_list(document, page, &operators.list, options, operators.fonts)
}

/// Paints an operator list of `page` (the list [`render_page`] reads, or one built by the caller) on a white canvas of
/// the size of the page's viewport at `options.scale` (`Math.ceil` of the viewport's width and height). A list built by
/// the caller does not bring its fonts, so the text of its Type3 fonts moves the text position and draws nothing.
pub fn render_operator_list(document: &Document, page: &Page, list: &OperatorList, options: &RenderOptions<'_>) -> Result<RenderedPage> {
    paint_operator_list(document, page, list, options, Vec::new())
}

/// The list painted, with the fonts it was made with (their Type3 glyph procedures).
fn paint_operator_list(document: &Document, page: &Page, list: &OperatorList, options: &RenderOptions<'_>, fonts: Vec<FontHandle>) -> Result<RenderedPage> {
    document.guard().check_now()?;
    let viewport = page.viewport(options.scale);
    let (width, height) = (viewport.width.ceil(), viewport.height.ceil());
    if !(width >= 1.0 && height >= 1.0 && width <= f64::from(u32::MAX) && height <= f64::from(u32::MAX)) {
        return Err(PdfError::Unknown(format!("a page of {width} by {height} pixels cannot be rendered")));
    }
    let mut canvas = Canvas::new(width as u32, height as u32).map_err(raster)?;
    canvas.set_fill_color("rgb(255,255,255)");
    canvas.fill_rect(0.0, 0.0, width as f32, height as f32);
    canvas.set_fill_color("#000000");
    let m = viewport.transform;
    canvas.transform(m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32, m[4] as f32, m[5] as f32);
    let resources = page.resources(document)?;
    let optional_content = OptionalContentConfig::read(document)?;
    let mut painter = Painter::new(canvas, document, resources, options.drawing, optional_content);
    let type3: HashMap<String, FontHandle> = fonts.into_iter().filter(|font| font.type3.is_some()).map(|font| (font.loaded_name.clone(), font)).collect();
    painter.type3_fonts = Arc::new(type3);
    painter.execute(list)?;
    Ok(RenderedPage { canvas: painter.into_base_canvas() })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::document::OpenOptions;

    /// A one-page PDF whose content stream is `content`.
    fn pdf(media_box: &str, content: &[u8]) -> Vec<u8> {
        pdf_with(media_box, content, "<< >>", &[])
    }

    /// A stream object: `dict` entries (without `/Length`) and the bytes.
    fn stream(dict: &str, bytes: &[u8]) -> Vec<u8> {
        [format!("<< {dict} /Length {} >>\nstream\n", bytes.len()).as_bytes(), bytes, b"\nendstream"].concat()
    }

    /// A one-page PDF with `resources` for its page and `extra` objects, numbered from 5.
    fn pdf_with(media_box: &str, content: &[u8], resources: &str, extra: &[Vec<u8>]) -> Vec<u8> {
        let mut objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] /Contents 4 0 R /Resources {resources} >>").into_bytes(),
            stream("", content),
        ];
        objects.extend(extra.iter().cloned());
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        let size = objects.len() + 1;
        out.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes());
        out
    }

    fn render(media_box: &str, content: &[u8], scale: f64) -> RenderedPage {
        render_with(media_box, content, "<< >>", &[], scale)
    }

    fn render_with(media_box: &str, content: &[u8], resources: &str, extra: &[Vec<u8>], scale: f64) -> RenderedPage {
        let document = Document::open(pdf_with(media_box, content, resources, extra), &OpenOptions::default()).expect("the PDF opens");
        let page = document.page(0).expect("page");
        let options = RenderOptions { scale, fonts: None, drawing: None };
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
        let fill = render("0 0 100 100", b"0 1 0 rg 10 10 80 80 re 30 30 40 40 re f*", 1.0);
        assert_eq!(pixel(&fill, 20, 50), [0, 255, 0, 255]);
        assert_eq!(pixel(&fill, 50, 50), [255, 255, 255, 255]);
        let clip = render("0 0 100 100", b"10 10 80 80 re 30 30 40 40 re W* n 0 0 0 rg 0 0 100 100 re f", 1.0);
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

    /// `r g b` at `(x, y)` within `tolerance` of `want`.
    fn near(page: &RenderedPage, x: u32, y: u32, want: [u8; 3], tolerance: u8) -> bool {
        let got = pixel(page, x, y);
        (0..3).all(|i| got[i].abs_diff(want[i]) <= tolerance) && got[3] == 255
    }

    fn red_to_blue() -> Vec<u8> {
        b"<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>".to_vec()
    }

    #[test]
    fn an_axial_shading_runs_from_one_colour_to_the_other_and_extends() {
        let page = render_with(
            "0 0 100 100",
            b"/S1 sh",
            "<< /Shading << /S1 5 0 R >> >>",
            &[b"<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [10 0 90 0] /Function 6 0 R /Extend [true true] >>".to_vec(), red_to_blue()],
            1.0,
        );
        assert!(near(&page, 1, 50, [255, 0, 0], 3), "{:?}", pixel(&page, 1, 50));
        assert!(near(&page, 50, 50, [128, 0, 128], 6), "{:?}", pixel(&page, 50, 50));
        assert!(near(&page, 98, 50, [0, 0, 255], 3), "{:?}", pixel(&page, 98, 50));
    }

    #[test]
    fn a_shading_without_extend_leaves_the_page_beyond_its_ends_alone() {
        let page = render_with(
            "0 0 100 100",
            b"/S1 sh",
            "<< /Shading << /S1 5 0 R >> >>",
            &[b"<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 0 80 0] /Function 6 0 R >>".to_vec(), red_to_blue()],
            1.0,
        );
        assert_eq!(pixel(&page, 5, 50), [255, 255, 255, 255]);
        assert_eq!(pixel(&page, 95, 50), [255, 255, 255, 255]);
        assert!(near(&page, 50, 50, [128, 0, 128], 6));
    }

    #[test]
    fn a_shading_pattern_fills_the_shape_and_only_the_shape() {
        let page = render_with(
            "0 0 100 100",
            b"/Pattern cs /P1 scn 20 20 60 60 re f",
            "<< /Pattern << /P1 5 0 R >> >>",
            &[b"<< /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [20 0 80 0] /Function 6 0 R >> >>".to_vec(), red_to_blue()],
            1.0,
        );
        assert!(near(&page, 22, 50, [235, 0, 20], 12), "{:?}", pixel(&page, 22, 50));
        assert!(near(&page, 77, 50, [20, 0, 235], 12), "{:?}", pixel(&page, 77, 50));
        assert_eq!(pixel(&page, 10, 50), [255, 255, 255, 255]);
        assert_eq!(pixel(&page, 50, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn a_tiling_pattern_repeats_its_cell_across_the_shape() {
        let cell = stream("/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>", b"1 0 0 rg 0 0 5 5 re f");
        let page = render_with("0 0 100 100", b"/Pattern cs /P1 scn 0 0 100 100 re f", "<< /Pattern << /P1 5 0 R >> >>", &[cell], 1.0);
        // The red square of each cell is the lower left quarter: device rows 95..100 of the bottom cell.
        assert_eq!(pixel(&page, 2, 97), [255, 0, 0, 255]);
        assert_eq!(pixel(&page, 42, 57), [255, 0, 0, 255]);
        assert_eq!(pixel(&page, 7, 97), [255, 255, 255, 255]);
        assert_eq!(pixel(&page, 2, 92), [255, 255, 255, 255]);
    }

    #[test]
    fn an_uncoloured_tiling_pattern_takes_the_colour_it_is_selected_with() {
        let cell = stream("/PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>", b"0 0 5 5 re f");
        let page = render_with(
            "0 0 100 100",
            b"/CS1 cs 0 0 1 /P1 scn 0 0 100 100 re f",
            "<< /ColorSpace << /CS1 [/Pattern /DeviceRGB] >> /Pattern << /P1 5 0 R >> >>",
            &[cell],
            1.0,
        );
        assert_eq!(pixel(&page, 2, 97), [0, 0, 255, 255]);
        assert_eq!(pixel(&page, 7, 97), [255, 255, 255, 255]);
    }

    fn luminosity_mask_page(mask: &str) -> RenderedPage {
        let group = stream("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>", mask.as_bytes());
        render_with(
            "0 0 100 100",
            b"/GS1 gs 1 0 0 rg 0 0 100 100 re f",
            "<< /ExtGState << /GS1 << /SMask << /Type /Mask /S /Luminosity /G 5 0 R >> >> >> >>",
            &[group],
            1.0,
        )
    }

    #[test]
    fn a_luminosity_soft_mask_shows_the_paint_where_the_mask_is_light() {
        let page = luminosity_mask_page("1 g 0 0 50 100 re f 0.5 g 50 0 25 100 re f");
        assert_eq!(pixel(&page, 25, 50), [255, 0, 0, 255]);
        assert!(near(&page, 60, 50, [255, 128, 128], 3), "{:?}", pixel(&page, 60, 50));
        assert_eq!(pixel(&page, 90, 50), [255, 255, 255, 255]);
    }

    #[test]
    fn an_alpha_soft_mask_follows_the_alpha_of_its_group() {
        let group = stream("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency >> /Resources << >>", b"0 g 0 0 50 100 re f");
        let page = render_with(
            "0 0 100 100",
            b"/GS1 gs 0 0 1 rg 0 0 100 100 re f",
            "<< /ExtGState << /GS1 << /SMask << /Type /Mask /S /Alpha /G 5 0 R >> >> >> >>",
            &[group],
            1.0,
        );
        assert_eq!(pixel(&page, 25, 50), [0, 0, 255, 255]);
        assert_eq!(pixel(&page, 75, 50), [255, 255, 255, 255]);
    }

    #[test]
    fn a_soft_mask_ends_with_the_state_that_selected_it() {
        let group =
            stream("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>", b"1 g 0 0 50 100 re f");
        let page = render_with(
            "0 0 100 100",
            b"q /GS1 gs 1 0 0 rg 0 0 100 40 re f Q 0 1 0 rg 0 60 100 40 re f",
            "<< /ExtGState << /GS1 << /SMask << /Type /Mask /S /Luminosity /G 5 0 R >> >> >> >>",
            &[group],
            1.0,
        );
        assert_eq!(pixel(&page, 25, 80), [255, 0, 0, 255]);
        assert_eq!(pixel(&page, 75, 80), [255, 255, 255, 255]);
        // After `Q` the mask is gone: the green band covers the whole width.
        assert_eq!(pixel(&page, 25, 10), [0, 255, 0, 255]);
        assert_eq!(pixel(&page, 75, 10), [0, 255, 0, 255]);
    }

    #[test]
    fn a_transparency_group_is_composited_as_one_object() {
        let form = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >> /Resources << >>",
            b"1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f",
        );
        let page = render_with("0 0 100 100", b"q /GS1 gs /Fm1 Do Q", "<< /ExtGState << /GS1 << /ca 0.5 >> >> /XObject << /Fm1 5 0 R >> >>", &[form], 1.0);
        // Where the squares overlap the blue one is on top inside the group, so the red does not show through it.
        assert!(near(&page, 50, 50, [128, 128, 255], 3), "{:?}", pixel(&page, 50, 50));
        assert!(near(&page, 20, 80, [255, 128, 128], 3), "{:?}", pixel(&page, 20, 80));
        assert_eq!(pixel(&page, 5, 50), [255, 255, 255, 255]);
    }

    #[test]
    fn a_blend_mode_blends_with_what_is_under_it() {
        let page = render_with(
            "0 0 100 100",
            b"1 0 0 rg 0 0 100 100 re f /GS1 gs 0 1 1 rg 0 0 50 100 re f",
            "<< /ExtGState << /GS1 << /BM /Multiply >> >> >>",
            &[],
            1.0,
        );
        // Multiply of red and cyan is black; the right half is red alone.
        assert_eq!(pixel(&page, 25, 50), [0, 0, 0, 255]);
        assert_eq!(pixel(&page, 75, 50), [255, 0, 0, 255]);
    }

    #[test]
    fn a_pattern_that_cannot_be_read_paints_hotpink() {
        let page = render_with(
            "0 0 100 100",
            b"/Pattern cs /P1 scn 0 0 100 100 re f",
            "<< /Pattern << /P1 5 0 R >> >>",
            &[b"<< /PatternType 2 /Shading << /ShadingType 9 /ColorSpace /DeviceRGB >> >>".to_vec()],
            1.0,
        );
        assert_eq!(pixel(&page, 50, 50), [255, 105, 180, 255]);
    }

    #[test]
    fn a_cancelled_document_stops_the_render() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let options = OpenOptions { cancel: Some(Arc::new(move || flag.load(Ordering::Relaxed))), ..OpenOptions::default() };
        let document = Document::open(pdf("0 0 10 10", b"0 0 5 5 re f"), &options).expect("opens while running");
        let page = document.page(0).expect("page");
        let render_options = RenderOptions { scale: 1.0, fonts: None, drawing: None };
        assert!(render_page(&document, &page, &render_options).is_ok());
        stop.store(true, Ordering::Relaxed);
        assert!(matches!(render_page(&document, &page, &render_options), Err(PdfError::Cancelled)));
    }
}
