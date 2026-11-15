//! Image XObjects and inline images as pdf.js 6.4.299 decodes them in the Node configurations (`PDFImage` of
//! `image.js`): the image's dictionary (`Decode` arrays, 1 to 16 bits per component, `ImageMask`, the colour key and
//! stencil `Mask`, `SMask` with its `Matte`, `SMaskInData`), the image codecs of its filter (`DCTDecode` through
//! pdf.js's own JPEG decoder, `CCITTFaxDecode`, `JBIG2Decode`, `JPXDecode`) and the colour spaces of
//! [`crate::color`], delivered as the [`ImageData`] pdf.js hands the renderer (`paintImageXObject`'s object) or the
//! stencil of an image mask ([`StencilMask`]).
//!
//! The entry points take what the operator list (`crate::oplist`) holds: the image's stream, the resources of the
//! content stream it is painted from (an inline image names its colour space in them) and whether it is inline.

mod decode;
mod jpeg;
mod smask;

use std::sync::Arc;

use self::decode::{PdfImage, buffer_length, format_error, truthy};
use crate::error::Result;
use crate::object::{Dict, Obj};
use crate::stream::PdfStream;
use crate::xref::Xref;

/// `ImageKind`: how the bytes of an [`ImageData`] are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ImageKind {
    /// One bit per pixel, rows padded to whole bytes, a set bit is white.
    Grayscale1bpp = 1,
    /// Red, green, blue.
    Rgb24 = 2,
    /// Red, green, blue, alpha.
    Rgba32 = 3,
}

/// The decoded image: `width x height` pixels in `kind`'s layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageData {
    pub width: usize,
    pub height: usize,
    /// The `Interpolate` entry, `None` when the image has none.
    pub interpolate: Option<bool>,
    pub kind: ImageKind,
    pub data: Vec<u8>,
}

/// The stencil of an image mask (`PDFImage.createMask`): one bit per pixel, a set bit paints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageMask {
    pub width: usize,
    pub height: usize,
    pub interpolate: Option<bool>,
    pub data: Vec<u8>,
}

/// What `createMask` gives: a one-pixel mask that paints is the solid fill of the colour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StencilMask {
    SingleOpaquePixel,
    Mask(ImageMask),
}

/// An image XObject, or an inline image the page does not paint as a small inline image
/// (`buildPaintImageXObject`'s `PDFImage.buildImage` and `createImageData(false)`), with its `SMask` or `Mask`.
pub fn decode_image(
    xref: &Xref,
    resources: Option<&Dict>,
    image: &Arc<PdfStream>,
    is_inline: bool,
) -> Result<ImageData> {
    PdfImage::build(xref, resources, image, is_inline)?.create_image_data(xref, false)
}

/// A small inline image without a mask (`new PDFImage` and `createImageData(true)`): always RGBA, or the 1 bit and
/// RGB layouts are widened to RGBA.
pub fn decode_small_inline_image(
    xref: &Xref,
    resources: Option<&Dict>,
    image: &Arc<PdfStream>,
) -> Result<ImageData> {
    PdfImage::new(xref, resources, image, true, None, None, false, None)?
        .create_image_data(xref, true)
}

/// An image mask (`PDFImage.createMask`).
pub fn decode_image_mask(xref: &Xref, image: &Arc<PdfStream>) -> Result<StencilMask> {
    let dict = &image.dict;
    let number = |obj: Obj| match obj {
        Obj::Num(n) => n,
        _ => f64::NAN,
    };
    let width = number(xref.get2(dict, "W", "Width")?);
    let height = number(xref.get2(dict, "H", "Height")?);
    let interpolate = match xref.get2(dict, "I", "Interpolate")? {
        Obj::Null => None,
        other => Some(truthy(&other)),
    };
    let decode = if dict.has("D") {
        xref.get_array(dict, "D")?
    } else {
        xref.get_array(dict, "Decode")?
    };
    let inverse_decode = matches!(&decode, Obj::Array(values) if values.first().and_then(Obj::as_num).is_some_and(|d| d > 0.0));
    let js_int = |x: f64| {
        i64::from(if x.is_finite() {
            x.trunc() as i64 as i32
        } else {
            0
        })
    };
    let row_bytes = (((js_int(width) + 7) as i32) >> 3).max(0) as usize;
    let rows = if height.is_finite() && height > 0.0 {
        height as usize
    } else {
        0
    };
    let computed_length = buffer_length(&[row_bytes, rows])?;
    let source = PdfImage::new(xref, None, image, false, None, None, false, None)?;
    let bytes = source.mask_bytes(xref, computed_length)?;
    if width == 1.0 && height == 1.0 && inverse_decode == (bytes.is_empty() || bytes[0] & 128 != 0)
    {
        return Ok(StencilMask::SingleOpaquePixel);
    }
    let actual_length = bytes.len();
    let data = if !inverse_decode {
        bytes
    } else {
        if actual_length > computed_length {
            return Err(format_error("offset is out of bounds"));
        }
        let mut data = vec![0xffu8; computed_length];
        data[..actual_length].copy_from_slice(&bytes);
        for byte in &mut data[..actual_length] {
            *byte ^= 0xff;
        }
        data
    };
    Ok(StencilMask::Mask(ImageMask {
        width: width as usize,
        height: rows,
        interpolate,
        data,
    }))
}

impl ImageData {
    /// The pixels as RGBA bytes, four per pixel, for a renderer: a 1-bit image is black and white, an RGB image is
    /// opaque.
    pub fn to_rgba(&self) -> Vec<u8> {
        match self.kind {
            ImageKind::Rgba32 => self.data.clone(),
            ImageKind::Rgb24 => {
                let mut out = Vec::with_capacity(self.data.len() / 3 * 4);
                for pixel in self.data.chunks_exact(3) {
                    out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                }
                out
            }
            ImageKind::Grayscale1bpp => {
                let stride = self.width.div_ceil(8);
                let mut out = Vec::with_capacity(self.width * self.height * 4);
                for y in 0..self.height {
                    for x in 0..self.width {
                        let byte = self.data.get(y * stride + x / 8).copied().unwrap_or(255);
                        let level = if byte >> (7 - x % 8) & 1 == 1 { 255 } else { 0 };
                        out.extend_from_slice(&[level, level, level, 255]);
                    }
                }
                out
            }
        }
    }

    /// The channel count of the raw pixels the image extraction hands to the PNG encoder
    /// (`pdfImageBuffer`: `round(bytes / (width * height))`, and only 1 to 4 channels are accepted). A 1-bit image,
    /// whose rows are packed, has no whole channel count and is skipped, as the extraction skips it.
    pub fn extraction_channels(&self) -> Option<usize> {
        if self.data.is_empty() || self.width == 0 || self.height == 0 {
            return None;
        }
        let ratio = self.data.len() as f64 / (self.width as f64 * self.height as f64);
        let channels = (ratio + 0.5).floor() as usize;
        (1..=4).contains(&channels).then_some(channels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(kind: ImageKind, width: usize, height: usize, data: Vec<u8>) -> ImageData {
        ImageData {
            width,
            height,
            interpolate: None,
            kind,
            data,
        }
    }

    #[test]
    fn rgb_becomes_opaque_rgba() {
        let image = rgba(ImageKind::Rgb24, 2, 1, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(image.to_rgba(), vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn one_bit_rows_are_padded_and_a_set_bit_is_white() {
        let image = rgba(
            ImageKind::Grayscale1bpp,
            3,
            2,
            vec![0b1010_0000, 0b0100_0000],
        );
        let out = image.to_rgba();
        let levels: Vec<u8> = out.chunks(4).map(|p| p[0]).collect();
        assert_eq!(levels, vec![255, 0, 255, 0, 255, 0]);
    }

    #[test]
    fn extraction_counts_whole_channels_only() {
        assert_eq!(
            rgba(ImageKind::Rgb24, 2, 2, vec![0; 12]).extraction_channels(),
            Some(3)
        );
        assert_eq!(
            rgba(ImageKind::Rgba32, 2, 2, vec![0; 16]).extraction_channels(),
            Some(4)
        );
        assert_eq!(
            rgba(ImageKind::Grayscale1bpp, 8, 2, vec![0; 2]).extraction_channels(),
            None
        );
        assert_eq!(
            rgba(ImageKind::Rgb24, 0, 2, vec![0; 2]).extraction_channels(),
            None
        );
    }
}
