//! `extractPdfImages`: each image a page paints, once, with how many times it is placed and where, as a PNG.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::ReadProof;
use mixdog_pdf::document::Document;
use mixdog_pdf::error::CancelCheck;
use mixdog_pdf::image::{self, ImageData};
use mixdog_pdf::oplist::gstate::transform;
use mixdog_pdf::oplist::{self, Op};
use mixdog_pdf::page::{Page, Viewport};
use mixdog_pdf::{Dict, PdfError};
use mixdog_raster::Image;
use serde_json::Value;

use super::layout::apply_point;
use super::{json_number, max_of, min_of, object, round2};
use crate::document::{AnalysisError, PdfSource, open_pdf, selected_pages};

const CANCELLED: &str = "PDF image extraction was cancelled";

/// An image the page paints: its pixel size, where it sits in the layout's top-left coordinates (the corners of the
/// unit square under the current transform), how many times it is painted and its pixels as a PNG.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedImage {
    pub page: usize,
    /// 1-based over the whole call.
    pub index: usize,
    pub width: usize,
    pub height: usize,
    pub x: f64,
    pub top: f64,
    pub placed_width: f64,
    pub placed_height: f64,
    pub placements: usize,
    pub mime_type: &'static str,
    pub png: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageExtraction {
    pub page_count: i64,
    pub images: Vec<ExtractedImage>,
}

/// `{ pages, signal }`.
#[derive(Clone, Default)]
pub struct ImageOptions {
    pub pages: Option<Vec<f64>>,
    pub cancel: Option<CancelCheck>,
}

/// An image paints the unit square under the current transform, so its corners under that transform are where it sits
/// on the page.
fn image_placement(viewport: &Viewport, ctm: &[f64]) -> (f64, f64, f64, f64) {
    let full = transform(&viewport.transform, ctm);
    let corners: Vec<(f64, f64)> = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)]
        .into_iter()
        .map(|point| apply_point(point, &full))
        .collect();
    let left = min_of(corners.iter().map(|p| p.0));
    let top = min_of(corners.iter().map(|p| p.1));
    (
        round2(left),
        round2(top),
        round2(max_of(corners.iter().map(|p| p.0)) - left),
        round2(max_of(corners.iter().map(|p| p.1)) - top),
    )
}

/// `pdfImageBuffer`: the pixels as a PNG, or none when the image has no data or no whole 1 to 4 channels.
fn png_of(image: &ImageData) -> Result<Option<Vec<u8>>, AnalysisError> {
    let Some(channels) = image.extraction_channels() else {
        return Ok(None);
    };
    let (Ok(width), Ok(height)) = (u32::try_from(image.width), u32::try_from(image.height)) else {
        return Err(AnalysisError::plain(
            "Input image exceeds the maximum supported pixel limit",
        ));
    };
    Image::from_raw(width, height, channels as u8, &image.data)
        .and_then(|raster| raster.to_png())
        .map(Some)
        .map_err(|error| AnalysisError::plain(error.message()))
}

fn collect_page_images(
    document: &Document,
    page: &Page,
    number: usize,
    images: &mut Vec<ExtractedImage>,
) -> Result<(), AnalysisError> {
    let reader = |error: PdfError| AnalysisError::from_pdf_or_cancelled(&error, CANCELLED);
    let list = oplist::get_operator_list(document, page, None).map_err(reader)?;
    let viewport = page.viewport(1.0);
    let resources = page.resources(document).map_err(reader)?;
    let xref = document.xref();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (index, (ctm, op)) in list.with_transforms().into_iter().enumerate() {
        let key = match op {
            Op::PaintInlineImage(_) => format!("inline-{index}"),
            Op::PaintImage(reference) => reference.id.clone(),
            _ => continue,
        };
        if let Some(at) = seen.get(&key) {
            images[*at].placements += 1;
            continue;
        }
        // A failure of the reader on one image leaves it out, as pdf.js hands the page an empty object for it.
        let decoded = match op {
            Op::PaintInlineImage(small) => {
                image::decode_small_inline_image(xref, Some(&*resources), &small.source)
            }
            Op::PaintImage(reference) => {
                // A large inline image is painted as an image XObject; it names its colour space in the resources,
                // and has no object number of its own.
                let inline = reference.source.dict.obj_id.is_none();
                let resources: Option<&Dict> = if inline { Some(&*resources) } else { None };
                image::decode_image(xref, resources, &reference.source, inline)
            }
            _ => continue,
        };
        let decoded = match decoded {
            Ok(decoded) => decoded,
            Err(error) if error.is_fatal() => return Err(reader(error)),
            Err(_) => continue,
        };
        let Some(png) = png_of(&decoded)? else {
            continue;
        };
        let (x, top, placed_width, placed_height) = image_placement(&viewport, &ctm);
        seen.insert(key, images.len());
        images.push(ExtractedImage {
            page: number,
            index: images.len() + 1,
            width: decoded.width,
            height: decoded.height,
            x,
            top,
            placed_width,
            placed_height,
            placements: 1,
            mime_type: "image/png",
            png,
        });
    }
    Ok(())
}

/// `extractPdfImages(path, { pages, signal })`.
pub fn extract_pdf_images<P: ReadProof>(
    proof: &P,
    source: PdfSource<'_>,
    options: &ImageOptions,
) -> Result<ImageExtraction, AnalysisError> {
    let document = open_pdf(proof, source, options.cancel.clone())?;
    let mut images = Vec::new();
    for number in selected_pages(document.num_pages(), options.pages.as_deref())? {
        if options.cancel.as_ref().is_some_and(|cancel| cancel()) {
            return Err(AnalysisError::plain(CANCELLED));
        }
        let page = document
            .page(number - 1)
            .map_err(|error| AnalysisError::from_pdf_or_cancelled(&error, CANCELLED))?;
        collect_page_images(&document, &page, number, &mut images)?;
    }
    Ok(ImageExtraction {
        page_count: document.num_pages(),
        images,
    })
}

impl ExtractedImage {
    /// The entry as Node returns it: with the PNG as base64 under `data` when `with_data`.
    pub fn to_json(&self, with_data: bool) -> Value {
        let mut pairs = vec![
            ("page", Value::from(self.page)),
            ("index", Value::from(self.index)),
            ("width", Value::from(self.width)),
            ("height", Value::from(self.height)),
            ("x", json_number(self.x)),
            ("top", json_number(self.top)),
            ("placedWidth", json_number(self.placed_width)),
            ("placedHeight", json_number(self.placed_height)),
            ("placements", Value::from(self.placements)),
            ("mimeType", Value::from(self.mime_type)),
        ];
        if with_data {
            pairs.push(("data", Value::from(STANDARD.encode(&self.png))));
        }
        object(pairs)
    }
}

impl ImageExtraction {
    /// `images` without their pixels beside `_images` with them, as Node returns the extraction.
    pub fn to_json(&self) -> Value {
        object(vec![
            ("pageCount", Value::from(self.page_count)),
            ("imageCount", Value::from(self.images.len())),
            (
                "images",
                Value::Array(
                    self.images
                        .iter()
                        .map(|image| image.to_json(false))
                        .collect(),
                ),
            ),
            (
                "_images",
                Value::Array(
                    self.images
                        .iter()
                        .map(|image| image.to_json(true))
                        .collect(),
                ),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use mixdog_pdf::Obj;
    use mixdog_pdf::image::ImageKind;

    use super::*;

    fn viewport() -> Viewport {
        Viewport::new([0.0, 0.0, 612.0, 792.0], 1.0, 1.0, Obj::Num(0.0), 0.0, 0.0)
            .expect("an upright viewport")
    }

    fn data(kind: ImageKind, width: usize, height: usize, bytes: Vec<u8>) -> ImageData {
        ImageData {
            width,
            height,
            interpolate: None,
            kind,
            data: bytes,
        }
    }

    #[test]
    fn placement_is_the_unit_square_under_the_transform() {
        let viewport = viewport();
        let (x, top, width, height) =
            image_placement(&viewport, &[50.0, 0.0, 0.0, 40.0, 100.0, 600.0]);
        assert_eq!((x, top, width, height), (100.0, 152.0, 50.0, 40.0));
    }

    #[test]
    fn a_rotated_image_is_placed_by_its_bounding_box() {
        let viewport = viewport();
        let (x, top, width, height) =
            image_placement(&viewport, &[0.0, 30.0, -30.0, 0.0, 200.0, 100.0]);
        assert_eq!((x, top, width, height), (170.0, 662.0, 30.0, 30.0));
    }

    #[test]
    fn whole_channels_become_a_png_and_a_packed_bit_image_is_skipped() {
        let rgb = data(ImageKind::Rgb24, 2, 1, vec![255, 0, 0, 0, 255, 0]);
        let png = png_of(&rgb).unwrap().unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = Image::decode(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 1));
        assert_eq!(decoded.to_raw(), vec![255, 0, 0, 0, 255, 0]);
        let bits = data(ImageKind::Grayscale1bpp, 8, 8, vec![0; 8]);
        assert_eq!(png_of(&bits).unwrap(), None);
    }

    #[test]
    fn a_buffer_that_is_not_whole_pixels_is_the_encoders_error() {
        let odd = data(ImageKind::Rgb24, 3, 1, vec![0; 7]);
        assert!(png_of(&odd).is_err());
    }

    #[test]
    fn the_json_lists_the_images_with_and_without_their_pixels() {
        let image = ExtractedImage {
            page: 1,
            index: 1,
            width: 2,
            height: 1,
            x: 1.5,
            top: 2.0,
            placed_width: 3.0,
            placed_height: 4.0,
            placements: 2,
            mime_type: "image/png",
            png: vec![1, 2, 3],
        };
        let extraction = ImageExtraction {
            page_count: 1,
            images: vec![image],
        };
        let json = extraction.to_json();
        assert_eq!(json["imageCount"], 1);
        assert!(json["images"][0].get("data").is_none());
        assert_eq!(json["_images"][0]["data"], "AQID");
    }
}
