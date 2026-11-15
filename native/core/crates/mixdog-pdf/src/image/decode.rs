//! `PDFImage` of pdf.js 6.4.299 (`image.js`) as the Node configurations run it (no `OffscreenCanvas`, no
//! `ImageDecoder`): what an image XObject or an inline image is (`Width`, `Height`, `BitsPerComponent`, the colour
//! space, `Decode`, `ImageMask`, `Mask`, `SMask`, `Matte`, `SMaskInData`), how its stream is decoded by the image
//! codec its last filter names (DCT through [`super::jpeg`], CCITT and JBIG2, JPX), and the conversion of its
//! components to the RGB(A) bytes of an [`ImageData`] (`createImageData`).
//!
//! The mask and soft-mask half of the conversion is in `smask.rs`.
//!
//! Where pdf.js hands a typed array of a fractional or huge length to an allocator this reader refuses the image
//! (an allocation above [`MAX_LENGTH`] bytes is pdf.js's `RangeError`).

use std::sync::Arc;

use super::jpeg::JpegImage;
use super::{ImageData, ImageKind};
use crate::codec::{self, ccitt::CcittParams, jbig2, jpx};
use crate::color::{ColorSpace, parse as parse_colour_space};
use crate::error::{PdfError, Result};
use crate::function::clamp;
use crate::object::{Dict, Obj};
use crate::stream::PdfStream;
use crate::xref::Xref;

/// The most bytes one image buffer may hold.
pub(super) const MAX_LENGTH: usize = 1 << 31;

pub(super) fn format_error(message: impl Into<String>) -> PdfError {
    PdfError::Format(message.into())
}

/// A buffer length that fits: the product of `factors`, or the `RangeError` of the typed array.
pub(super) fn buffer_length(factors: &[usize]) -> Result<usize> {
    let mut total: usize = 1;
    for factor in factors {
        total = total
            .checked_mul(*factor)
            .filter(|t| *t <= MAX_LENGTH)
            .ok_or_else(|| format_error("Invalid typed array length"))?;
    }
    Ok(total)
}

/// JavaScript truthiness of a PDF value (`dict.get(..) || false`).
pub(super) fn truthy(obj: &Obj) -> bool {
    match obj {
        Obj::Null => false,
        Obj::Bool(b) => *b,
        Obj::Num(n) => *n != 0.0 && !n.is_nan(),
        _ => true,
    }
}

/// `1 << bits` of JavaScript (the count modulo 32, a 32-bit result).
fn js_shl1(bits: u32) -> i32 {
    1i32.wrapping_shl(bits)
}

/// `(1 << bpc) - 1`.
pub(super) fn max_value(bpc: u32) -> f64 {
    f64::from(js_shl1(bpc)) - 1.0
}

/// How the image's stream is decoded: the image codec its last filter names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Codec {
    /// No image codec: the stream's own bytes.
    None,
    Dct,
    Ccitt,
    Jbig2,
    Jpx,
}

fn codec_of(name: &str) -> Codec {
    match name {
        "DCT" | "DCTDecode" => Codec::Dct,
        "CCF" | "CCITTFaxDecode" => Codec::Ccitt,
        "JBIG2Decode" => Codec::Jbig2,
        "JPX" | "JPXDecode" => Codec::Jpx,
        _ => Codec::None,
    }
}

/// What a JPX stream's decoder is asked for (`jpxDecoderOptions`).
#[derive(Debug, Clone, Copy)]
struct JpxOptions {
    num_components: usize,
    is_indexed: bool,
    smask_in_data: bool,
}

/// The `/Mask` of an image: a stencil image or colour key ranges.
pub(super) enum MaskInput {
    Stream(Arc<PdfStream>),
    ColourKey(Vec<f64>),
}

/// What the mask of an image is once built.
pub(super) enum MaskKind {
    None,
    Image(Box<PdfImage>),
    ColourKey(Vec<f64>),
}

/// What the colour space asks the decoded components to be resized to and how they are read (`getImageBytes`'s
/// options).
#[derive(Debug, Clone, Copy, Default)]
struct BytesOptions {
    draw_width: Option<usize>,
    draw_height: Option<usize>,
    force_rgba: bool,
    force_rgb: bool,
}

/// The components of an image as `getComponents` returns them: bytes, 16-bit or 32-bit integers.
pub(super) enum Comps {
    U8(Vec<u8>),
    U16(Vec<u16>),
    U32(Vec<u32>),
}

impl Comps {
    pub(super) fn len(&self) -> usize {
        match self {
            Comps::U8(v) => v.len(),
            Comps::U16(v) => v.len(),
            Comps::U32(v) => v.len(),
        }
    }

    /// `comps[i]`: past the end is `undefined`, read as `NaN`.
    pub(super) fn get(&self, i: usize) -> f64 {
        match self {
            Comps::U8(v) => v.get(i).map_or(f64::NAN, |x| f64::from(*x)),
            Comps::U16(v) => v.get(i).map_or(f64::NAN, |x| f64::from(*x)),
            Comps::U32(v) => v.get(i).map_or(f64::NAN, |x| f64::from(*x)),
        }
    }

    /// `comps[i] = value`: a typed-array store (truncated, `NaN` is 0, a write past the end is dropped).
    fn set(&mut self, i: usize, value: f64) {
        let integer = value as u32;
        match self {
            Comps::U8(v) => {
                if let Some(slot) = v.get_mut(i) {
                    *slot = integer as u8;
                }
            }
            Comps::U16(v) => {
                if let Some(slot) = v.get_mut(i) {
                    *slot = integer as u16;
                }
            }
            Comps::U32(v) => {
                if let Some(slot) = v.get_mut(i) {
                    *slot = integer;
                }
            }
        }
    }
}

/// A `PDFImage`.
pub(super) struct PdfImage {
    pub(super) width: usize,
    pub(super) height: usize,
    pub(super) interpolate: Option<bool>,
    pub(super) matte: Option<Vec<f64>>,
    pub(super) bpc: u32,
    pub(super) num_comps: usize,
    pub(super) colour_space: Option<Arc<ColorSpace>>,
    pub(super) needs_decode: bool,
    decode_coefficients: Vec<f64>,
    decode_addends: Vec<f64>,
    pub(super) smask: Option<Box<PdfImage>>,
    pub(super) mask: MaskKind,
    stream: Arc<PdfStream>,
    /// The stream's bytes after every filter but the image codec.
    bytes: Vec<u8>,
    codec: Codec,
    /// The parameters of the last filter.
    params: Option<Arc<Dict>>,
    jpx: Option<JpxOptions>,
    jpx_premultiplied: bool,
    preblend_matte: Option<[u8; 3]>,
}

fn number(obj: &Obj) -> Option<f64> {
    match obj {
        Obj::Num(n) => Some(*n),
        _ => None,
    }
}

/// `dict.getArray(key1, key2)` of numbers (a non-number element is `NaN`), `None` when it is not an array.
fn number_array(xref: &Xref, dict: &Dict, key1: &str, key2: &str) -> Result<Option<Vec<f64>>> {
    let value = if dict.has(key1) {
        xref.get_array(dict, key1)?
    } else {
        xref.get_array(dict, key2)?
    };
    Ok(match value {
        Obj::Array(items) => Some(
            items
                .iter()
                .map(|o| number(o).unwrap_or(f64::NAN))
                .collect(),
        ),
        _ => None,
    })
}

/// `dict.getRaw(key1) || dict.getRaw(key2)`.
fn raw_either<'a>(dict: &'a Dict, key1: &str, key2: &str) -> Option<&'a Obj> {
    match dict.get_raw(key1) {
        Some(obj) if truthy(obj) || matches!(obj, Obj::Ref(_)) => Some(obj),
        _ => dict
            .get_raw(key2)
            .filter(|obj| truthy(obj) || matches!(obj, Obj::Ref(_))),
    }
}

impl PdfImage {
    /// The `PDFImage` constructor. `res` is the resources of the content stream (read only for an inline image).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        xref: &Xref,
        res: Option<&Dict>,
        image: &Arc<PdfStream>,
        is_inline: bool,
        smask: Option<&Arc<PdfStream>>,
        mask: Option<MaskInput>,
        is_mask: bool,
        fallback_dims: Option<(f64, f64)>,
    ) -> Result<PdfImage> {
        let dict = &image.dict;
        let chain = image.chain();
        let codec = chain.last().map_or(Codec::None, |f| codec_of(&f.name));
        let params = chain.last().and_then(|f| f.params.clone());
        let bytes = image.decode(xref.filters().as_ref(), xref.guard())?;
        let first_filter = match xref.get2(dict, "F", "Filter")? {
            Obj::Name(name) => Some(name.to_string()),
            Obj::Array(items) => match items.first() {
                Some(first) => match xref.fetch_if_ref(first, false)? {
                    Obj::Name(name) => Some(name.to_string()),
                    _ => None,
                },
                None => None,
            },
            _ => None,
        };
        // The dimensions and components the codec itself reports (`image.width`, `image.numComps`, ...).
        let mut codec_width: Option<f64> = None;
        let mut codec_height: Option<f64> = None;
        let mut codec_comps: Option<usize> = None;
        let mut codec_bpc: Option<u32> = None;
        let mut jpx_options: Option<JpxOptions> = None;
        match first_filter.as_deref() {
            Some("JPXDecode") => {
                let (w, h, comps) = parse_jpx_properties(&bytes)?;
                codec_width = Some(w);
                codec_height = Some(h);
                codec_comps = Some(comps);
                codec_bpc = Some(8);
                jpx_options = Some(JpxOptions {
                    num_components: 0,
                    is_indexed: false,
                    smask_in_data: number(&xref.get(dict, "SMaskInData")?)
                        .is_some_and(|n| n >= 1.0),
                });
            }
            Some("JBIG2Decode") => {
                codec_bpc = Some(1);
                codec_comps = Some(1);
            }
            _ => {}
        }
        let mut width = number(&xref.get2(dict, "W", "Width")?);
        let mut height = number(&xref.get2(dict, "H", "Height")?);
        let is_valid = |n: f64| n.is_finite() && n.fract() == 0.0 && n > 0.0;
        if let (Some(cw), Some(ch)) = (codec_width, codec_height)
            && is_valid(cw)
            && is_valid(ch)
            && (Some(cw) != width || Some(ch) != height)
        {
            tracing::warn!(
                "PDFImage - using the Width/Height of the image data, rather than the image dictionary."
            );
            width = Some(cw);
            height = Some(ch);
        } else {
            let valid_width = width.is_some_and(|w| w > 0.0);
            let valid_height = height.is_some_and(|h| h > 0.0);
            if !valid_width || !valid_height {
                let Some((fw, fh)) = fallback_dims else {
                    return Err(format_error(format!(
                        "Invalid image width: {} or height: {}",
                        width.map_or("undefined".to_owned(), |w| w.to_string()),
                        height.map_or("undefined".to_owned(), |h| h.to_string())
                    )));
                };
                tracing::warn!(
                    "PDFImage - using the Width/Height of the parent image, for SMask/Mask data."
                );
                if !valid_width {
                    width = Some(fw);
                }
                if !valid_height {
                    height = Some(fh);
                }
            }
        }
        let (width_f, height_f) = (width.unwrap_or(f64::NAN), height.unwrap_or(f64::NAN));
        let to_size = |n: f64| -> Result<usize> {
            if n.is_finite() && n >= 0.0 && n < MAX_LENGTH as f64 {
                Ok(n as usize)
            } else {
                Err(format_error("Invalid typed array length"))
            }
        };
        let (width, height) = (to_size(width_f)?, to_size(height_f)?);
        let interpolate = match xref.get2(dict, "I", "Interpolate")? {
            Obj::Bool(b) => Some(b),
            Obj::Null => None,
            other => Some(truthy(&other)),
        };
        let image_mask = truthy(&xref.get2(dict, "IM", "ImageMask")?);
        let matte: Option<Vec<f64>> = match xref.get(dict, "Matte")? {
            Obj::Array(items) => Some(
                items
                    .iter()
                    .map(|o| number(o).unwrap_or(f64::NAN))
                    .collect(),
            ),
            _ => None,
        };
        let mut bpc = codec_bpc.unwrap_or(0);
        if bpc == 0 {
            let declared = number(&xref.get2(dict, "BPC", "BitsPerComponent")?)
                .filter(|n| *n != 0.0 && !n.is_nan());
            match declared {
                Some(n) => bpc = n as u32,
                None if image_mask => bpc = 1,
                None => {
                    return Err(format_error(format!(
                        "Bits per component missing in image: {image_mask}"
                    )));
                }
            }
        }
        let resources = if is_inline { res } else { None };
        let mut jpx_premultiplied = false;
        let mut preblend_matte = None;
        let mut colour_space: Option<Arc<ColorSpace>> = None;
        let num_comps;
        if !image_mask {
            let raw = raw_either(dict, "CS", "ColorSpace").cloned();
            let has_colour_space = raw.is_some();
            if let Some(options) = jpx_options
                && options.smask_in_data
                && number(&xref.get(dict, "SMaskInData")?) == Some(2.0)
            {
                jpx_premultiplied = true;
                if let Some(matte) = &matte {
                    let matte_space = match &raw {
                        Some(cs) => parse_colour_space(cs, xref, resources)?,
                        None => parse_colour_space(&Obj::name("DeviceRGB"), xref, resources)?,
                    };
                    preblend_matte = Some(matte_space.get_rgb(matte, 0)?);
                }
            }
            let space_obj = if !has_colour_space {
                if jpx_options.is_some() {
                    Obj::name("DeviceRGBA")
                } else {
                    match codec_comps {
                        Some(1) => Obj::name("DeviceGray"),
                        Some(3) => Obj::name("DeviceRGB"),
                        Some(4) => Obj::name("DeviceCMYK"),
                        other => {
                            return Err(format_error(format!(
                                "Images with {} color components not supported.",
                                other.map_or("undefined".to_owned(), |n| n.to_string())
                            )));
                        }
                    }
                }
            } else if jpx_options.is_some_and(|o| o.smask_in_data) {
                Obj::name("DeviceRGBA")
            } else {
                raw.clone().unwrap_or(Obj::Null)
            };
            let space = parse_colour_space(&space_obj, xref, resources)?;
            num_comps = space.num_comps();
            if let Some(options) = jpx_options.as_mut() {
                options.num_components = if has_colour_space { num_comps } else { 0 };
                options.is_indexed = space.name() == "Indexed";
            }
            colour_space = Some(space);
        } else {
            num_comps = 1;
        }
        let decode = number_array(xref, dict, "D", "Decode")?;
        let mut needs_decode = false;
        let mut decode_coefficients = Vec::new();
        let mut decode_addends = Vec::new();
        if let Some(decode) = &decode {
            let default_for_space = match &colour_space {
                Some(space) => {
                    Some(space.is_default_decode(Some(decode.as_slice()), f64::from(bpc))?)
                }
                None => None,
            };
            let mask_not_default =
                is_mask && !ColorSpace::gray().is_default_decode(Some(decode.as_slice()), 1.0)?;
            if default_for_space == Some(false) || mask_not_default {
                needs_decode = true;
                let max = max_value(bpc);
                let is_indexed = colour_space.as_ref().is_some_and(|s| s.name() == "Indexed");
                for pair in decode.chunks(2) {
                    let dmin = pair[0];
                    let dmax = pair.get(1).copied().unwrap_or(f64::NAN);
                    if is_indexed {
                        decode_coefficients.push((dmax - dmin) / max);
                        decode_addends.push(dmin);
                    } else {
                        decode_coefficients.push(dmax - dmin);
                        decode_addends.push(max * dmin);
                    }
                }
            }
        }
        let mut result = PdfImage {
            width,
            height,
            interpolate,
            matte,
            bpc,
            num_comps,
            colour_space,
            needs_decode,
            decode_coefficients,
            decode_addends,
            smask: None,
            mask: MaskKind::None,
            stream: image.clone(),
            bytes,
            codec,
            params,
            jpx: jpx_options,
            jpx_premultiplied,
            preblend_matte,
        };
        let dims = Some((width_f, height_f));
        if let Some(smask) = smask {
            result.smask = Some(Box::new(PdfImage::new(
                xref, res, smask, is_inline, None, None, false, dims,
            )?));
        } else if let Some(mask) = mask {
            match mask {
                MaskInput::Stream(stream) => {
                    if truthy(&xref.get2(&stream.dict, "IM", "ImageMask")?) {
                        result.mask = MaskKind::Image(Box::new(PdfImage::new(
                            xref, res, &stream, is_inline, None, None, true, dims,
                        )?));
                    } else {
                        tracing::warn!("Ignoring /Mask in image without /ImageMask.");
                    }
                }
                MaskInput::ColourKey(ranges) => result.mask = MaskKind::ColourKey(ranges),
            }
        }
        Ok(result)
    }

    /// `PDFImage.buildImage`: the image with the `SMask` or `Mask` of its dictionary.
    pub(super) fn build(
        xref: &Xref,
        res: Option<&Dict>,
        image: &Arc<PdfStream>,
        is_inline: bool,
    ) -> Result<PdfImage> {
        let dict = &image.dict;
        let mut smask_stream: Option<Arc<PdfStream>> = None;
        let mut mask: Option<MaskInput> = None;
        let smask = xref.get(dict, "SMask")?;
        let mask_obj = xref.get(dict, "Mask")?;
        if truthy(&smask) {
            match smask {
                Obj::Stream(s) => smask_stream = Some(s),
                _ => tracing::warn!("Unsupported /SMask format."),
            }
        } else if truthy(&mask_obj) {
            match mask_obj {
                Obj::Stream(s) => mask = Some(MaskInput::Stream(s)),
                Obj::Array(_) => {
                    let ranges = number_array(xref, dict, "Mask", "Mask")?.unwrap_or_default();
                    mask = Some(MaskInput::ColourKey(ranges));
                }
                _ => tracing::warn!("Unsupported /Mask format."),
            }
        }
        PdfImage::new(
            xref,
            res,
            image,
            is_inline,
            smask_stream.as_ref(),
            mask,
            false,
            None,
        )
    }

    /// `drawWidth`.
    pub(super) fn draw_width(&self) -> usize {
        let smask = self.smask.as_ref().map_or(0, |s| s.width);
        let mask = match &self.mask {
            MaskKind::Image(m) => m.width,
            _ => 0,
        };
        self.width.max(smask).max(mask)
    }

    /// `drawHeight`.
    pub(super) fn draw_height(&self) -> usize {
        let smask = self.smask.as_ref().map_or(0, |s| s.height);
        let mask = match &self.mask {
            MaskKind::Image(m) => m.height,
            _ => 0,
        };
        self.height.max(smask).max(mask)
    }

    pub(super) fn has_mask(&self) -> bool {
        self.smask.is_some() || !matches!(self.mask, MaskKind::None)
    }

    // ---- bytes -------------------------------------------------------------------------------------------------

    /// `getImageBytes(length, options)` / `image.getImageData(length)`: the stream's samples, through the image
    /// codec its last filter names. `length` truncates what a plain or DCT stream gives (0 is "all"); the other
    /// codecs deliver their whole buffer.
    fn image_bytes(&self, xref: &Xref, length: usize, options: BytesOptions) -> Result<Vec<u8>> {
        let truncate = |mut data: Vec<u8>| {
            if length > 0 && data.len() > length {
                data.truncate(length);
            }
            data
        };
        let dict = &self.stream.dict;
        match self.codec {
            Codec::None => Ok(truncate(self.bytes.clone())),
            Codec::Dct => {
                let data = skip_useless_bytes(&self.bytes);
                let transform = match &self.params {
                    Some(p) => match xref.get(p, "ColorTransform")? {
                        Obj::Num(n) if n.fract() == 0.0 => Some(n as i64),
                        _ => None,
                    },
                    None => None,
                };
                let jpeg = JpegImage::parse(data, transform)?;
                let draw_width = options.draw_width.unwrap_or(self.width);
                let draw_height = options.draw_height.unwrap_or(self.height);
                // The largest buffer `getData` allocates: the interleaved components, or the RGB(A) widening.
                let output_channels = if options.force_rgba {
                    4
                } else if options.force_rgb {
                    3
                } else {
                    1
                };
                buffer_length(&[
                    draw_width,
                    draw_height,
                    jpeg.num_components().max(output_channels),
                ])?;
                Ok(truncate(jpeg.get_data(
                    draw_width,
                    draw_height,
                    options.force_rgba,
                    options.force_rgb,
                )?))
            }
            Codec::Ccitt => {
                let params = self.params.as_deref();
                let int = |key: &str| -> Result<Option<f64>> {
                    Ok(match params {
                        Some(p) => number(&xref.get(p, key)?).filter(|n| *n != 0.0 && !n.is_nan()),
                        None => None,
                    })
                };
                let flag = |key: &str| -> Result<bool> {
                    Ok(match params {
                        Some(p) => truthy(&xref.get(p, key)?),
                        None => false,
                    })
                };
                let ccitt = CcittParams {
                    k: codec::to_int32(int("K")?.unwrap_or(0.0)),
                    end_of_line: flag("EndOfLine")?,
                    encoded_byte_align: flag("EncodedByteAlign")?,
                    columns: codec::to_int32(int("Columns")?.unwrap_or(1728.0)),
                    rows: codec::to_int32(int("Rows")?.unwrap_or(0.0)),
                    black_is_1: flag("BlackIs1")?,
                };
                let width = number(&xref.get2(dict, "W", "Width")?).unwrap_or(f64::NAN);
                let height = number(&xref.get2(dict, "H", "Height")?).unwrap_or(f64::NAN);
                codec::ccitt::decode(
                    &self.bytes,
                    codec::to_int32(width),
                    codec::to_int32(height),
                    &ccitt,
                )
                .map_err(codec_error)
            }
            Codec::Jbig2 => {
                let globals = match &self.params {
                    Some(p) => match xref.get(p, "JBIG2Globals")? {
                        Obj::Stream(stream) => {
                            let bytes = stream.decode(xref.filters().as_ref(), xref.guard())?;
                            Some(jbig2::strip_file_header(&bytes).to_vec())
                        }
                        _ => None,
                    },
                    None => None,
                };
                let width = number(&xref.get(dict, "Width")?).unwrap_or(f64::NAN);
                let height = number(&xref.get(dict, "Height")?).unwrap_or(f64::NAN);
                jbig2::decode(
                    jbig2::strip_file_header(&self.bytes),
                    codec::to_int32(width),
                    codec::to_int32(height),
                    globals.as_deref(),
                )
                .map_err(codec_error)
            }
            Codec::Jpx => {
                let options = self.jpx.unwrap_or(JpxOptions {
                    num_components: 4,
                    is_indexed: false,
                    smask_in_data: false,
                });
                jpx_pixels(&self.bytes, options)
            }
        }
    }

    // ---- components --------------------------------------------------------------------------------------------

    /// `getComponents`: the samples of the buffer as one integer per component.
    pub(super) fn components(&self, buffer: Vec<u8>) -> Result<Comps> {
        let bpc = self.bpc;
        if bpc == 8 {
            return Ok(Comps::U8(buffer));
        }
        let (width, height, num_comps) = (self.width, self.height, self.num_comps);
        let length = buffer_length(&[width, height, num_comps])?;
        let row_comps = width * num_comps;
        let at = |i: usize| -> u32 { buffer.get(i).map_or(0, |b| u32::from(*b)) };
        let mut samples: Vec<u32> = Vec::new();
        let mut small: Vec<u8> = Vec::new();
        let mut medium: Vec<u16> = Vec::new();
        let mut push = |value: u32| {
            if bpc <= 8 {
                small.push(value as u8);
            } else if bpc <= 16 {
                medium.push(value as u16);
            } else {
                samples.push(value);
            }
        };
        let mut pos = 0usize;
        if bpc == 1 {
            for _ in 0..height {
                for x in 0..row_comps {
                    push(at(pos + (x >> 3)) >> (7 - (x & 7)) & 1);
                }
                pos += row_comps.div_ceil(8);
            }
        } else {
            let max = max_value(bpc);
            let mut bits: u32 = 0;
            let mut buf: i32 = 0;
            for i in 0..length {
                if row_comps != 0 && i % row_comps == 0 {
                    buf = 0;
                    bits = 0;
                }
                while bits < bpc {
                    buf = buf.wrapping_shl(8) | at(pos) as i32;
                    pos += 1;
                    bits += 8;
                }
                let remaining = bits - bpc;
                let value = clamp(f64::from(buf >> (remaining & 31)), 0.0, max);
                push(if value.is_nan() { 0 } else { value as u32 });
                buf &= js_shl1(remaining).wrapping_sub(1);
                bits = remaining;
            }
        }
        Ok(if bpc <= 8 {
            Comps::U8(small)
        } else if bpc <= 16 {
            Comps::U16(medium)
        } else {
            Comps::U32(samples)
        })
    }

    /// `decodeBuffer`: applies the `Decode` array to the components.
    pub(super) fn decode_buffer(&self, comps: &mut Comps) {
        if self.bpc == 1 {
            for i in 0..comps.len() {
                let flipped = if comps.get(i) == 0.0 { 1.0 } else { 0.0 };
                comps.set(i, flipped);
            }
            return;
        }
        let max = max_value(self.bpc);
        let mut index = 0usize;
        for _ in 0..self.width * self.height {
            for j in 0..self.num_comps {
                let addend = self.decode_addends.get(j).copied().unwrap_or(f64::NAN);
                let coefficient = self.decode_coefficients.get(j).copied().unwrap_or(f64::NAN);
                comps.set(
                    index,
                    clamp(addend + comps.get(index) * coefficient, 0.0, max),
                );
                index += 1;
            }
        }
    }

    // ---- createImageData ---------------------------------------------------------------------------------------

    /// `createImageData(forceRGBA, false)`.
    pub(super) fn create_image_data(&self, xref: &Xref, force_rgba: bool) -> Result<ImageData> {
        let Some(space) = self.colour_space.clone() else {
            return Err(format_error("Cannot read properties of undefined"));
        };
        let draw_width = self.draw_width();
        let draw_height = self.draw_height();
        let (width, height, bpc) = (self.width, self.height, self.bpc);
        let row_bytes =
            ((width as u128 * self.num_comps as u128 * u128::from(bpc) + 7) >> 3) as usize;
        let mut result = ImageData {
            width: draw_width,
            height: draw_height,
            interpolate: self.interpolate,
            kind: ImageKind::Grayscale1bpp,
            data: Vec::new(),
        };
        let space_name = space.name();
        let no_mask = !self.has_mask();
        if no_mask && space_name == "DeviceRGBA" {
            result.kind = ImageKind::Rgba32;
            let length = buffer_length(&[height, width, 4])?;
            let mut data = self.image_bytes(xref, length, BytesOptions::default())?;
            if self.jpx_premultiplied {
                let matte = self.preblend_matte.unwrap_or([0, 0, 0]);
                undo_preblend(&mut data, matte);
            }
            result.data = data;
            return Ok(result);
        }
        if !force_rgba && no_mask {
            let kind = if space_name == "DeviceGray" && bpc == 1 {
                Some(ImageKind::Grayscale1bpp)
            } else if space_name == "DeviceRGB" && bpc == 8 && !self.needs_decode {
                Some(ImageKind::Rgb24)
            } else {
                None
            };
            if let Some(kind) = kind
                && draw_width == width
                && draw_height == height
            {
                let mut data = self.image_bytes(
                    xref,
                    buffer_length(&[height, row_bytes])?,
                    BytesOptions::default(),
                )?;
                result.kind = kind;
                if self.needs_decode {
                    for byte in &mut data {
                        *byte ^= 0xff;
                    }
                }
                result.data = data;
                return Ok(result);
            }
            if self.codec == Codec::Dct
                && !self.needs_decode
                && matches!(space_name, "DeviceGray" | "DeviceRGB" | "DeviceCMYK")
            {
                let mut length = buffer_length(&[height, row_bytes])?;
                if space_name == "DeviceGray" {
                    length *= 3;
                }
                result.kind = ImageKind::Rgb24;
                result.data = self.image_bytes(
                    xref,
                    length,
                    BytesOptions {
                        draw_width: Some(draw_width),
                        draw_height: Some(draw_height),
                        force_rgba: false,
                        force_rgb: true,
                    },
                )?;
                return Ok(result);
            }
        }
        let image_bytes = self.image_bytes(
            xref,
            buffer_length(&[height, row_bytes])?,
            BytesOptions::default(),
        )?;
        let actual_height = if row_bytes == 0 {
            0
        } else {
            (image_bytes.len() as f64 / row_bytes as f64 * draw_height as f64 / height as f64)
                as usize
        };
        let mut comps = self.components(image_bytes)?;
        result.kind = ImageKind::Rgba32;
        let alpha01;
        let maybe_undo_preblend;
        let mut data;
        if !force_rgba && no_mask {
            result.kind = ImageKind::Rgb24;
            data = vec![0u8; buffer_length(&[draw_width, draw_height, 3])?];
            alpha01 = 0;
            maybe_undo_preblend = false;
        } else {
            data = vec![0u8; buffer_length(&[draw_width, draw_height, 4])?];
            alpha01 = 1;
            maybe_undo_preblend = true;
            self.fill_opacity(
                xref,
                &mut data,
                draw_width,
                draw_height,
                actual_height,
                &comps,
            )?;
        }
        if self.needs_decode {
            self.decode_buffer(&mut comps);
        }
        match &comps {
            Comps::U8(c) => space.fill_rgb(
                &mut data,
                width,
                height,
                draw_width,
                draw_height,
                actual_height,
                bpc,
                c,
                alpha01,
            )?,
            Comps::U16(c) => space.fill_rgb(
                &mut data,
                width,
                height,
                draw_width,
                draw_height,
                actual_height,
                bpc,
                c,
                alpha01,
            )?,
            Comps::U32(c) => space.fill_rgb(
                &mut data,
                width,
                height,
                draw_width,
                draw_height,
                actual_height,
                bpc,
                c,
                alpha01,
            )?,
        }
        if maybe_undo_preblend {
            self.undo_preblend(&mut data, draw_width, actual_height)?;
        }
        result.data = data;
        Ok(result)
    }

    /// The bytes a stencil mask paints (`PDFImage.createMask`'s `getImageData`), at most `length` of them. A DCT
    /// stream is asked for the samples of an image of no size there (pdf.js sets the draw size on the stream only
    /// in `getImageBytes`, which `createMask` does not use): it is parsed, and fails when it is damaged, but gives
    /// no bytes.
    pub(super) fn mask_bytes(&self, xref: &Xref, length: usize) -> Result<Vec<u8>> {
        let options = if self.codec == Codec::Dct {
            BytesOptions {
                draw_width: Some(0),
                draw_height: Some(0),
                ..BytesOptions::default()
            }
        } else {
            BytesOptions::default()
        };
        self.image_bytes(xref, length, options)
    }

    /// The samples of the buffer for a gray sub-image (`getImageBytes(length, { internal: true })`).
    pub(super) fn gray_bytes(&self, xref: &Xref, length: usize) -> Result<Vec<u8>> {
        self.image_bytes(xref, length, BytesOptions::default())
    }
}

/// `undoPreblend` of a whole RGBA buffer without a soft mask (the premultiplied alpha of a JPX image).
fn undo_preblend(buffer: &mut [u8], matte: [u8; 3]) {
    let length = buffer.len();
    super::smask::undo_preblend_buffer(buffer, length, matte);
}

fn codec_error(error: codec::CodecError) -> PdfError {
    PdfError::Unknown(error.message().to_owned())
}

/// `JpegStream.#skipUselessBytes`: the data from the first SOI marker.
fn skip_useless_bytes(data: &[u8]) -> &[u8] {
    for i in 0..data.len().saturating_sub(1) {
        if data[i] == 0xff && data[i + 1] == 0xd8 {
            return &data[i..];
        }
    }
    data
}

/// `JpxImage.parseImageProperties`: `(width, height, components)` from the SIZ marker, found by scanning the bytes.
fn parse_jpx_properties(bytes: &[u8]) -> Result<(f64, f64, usize)> {
    let at = |i: usize| -> i32 { bytes.get(i).map_or(-1, |b| i32::from(*b)) };
    let int32 = |i: usize| -> u32 {
        ((at(i) << 24) + (at(i + 1) << 16) + (at(i + 2) << 8) + at(i + 3)) as u32
    };
    let mut pos = 0usize;
    let mut new_byte = at(pos);
    pos += 1;
    while new_byte >= 0 {
        let old_byte = new_byte;
        new_byte = at(pos);
        pos += 1;
        if (old_byte << 8 | new_byte) == 0xff51 {
            pos += 4;
            let xsiz = f64::from(int32(pos));
            let ysiz = f64::from(int32(pos + 4));
            let xosiz = f64::from(int32(pos + 8));
            let yosiz = f64::from(int32(pos + 12));
            pos += 16 + 16;
            let csiz = ((at(pos) << 8) + at(pos + 1)).max(0) as usize;
            return Ok((xsiz - xosiz, ysiz - yosiz, csiz));
        }
    }
    Err(PdfError::Unknown(
        "No size marker found in JPX stream".to_owned(),
    ))
}

/// `JpxImage.decode`: the 8-bit interleaved samples OpenJPEG's wasm wrapper delivers. Inferred from what pdf.js
/// gives (the wrapper has no source in the tree; checked against the recording): with no component count asked for,
/// or with the alpha of `SMaskInData`, every image is delivered as RGBA (gray, gray and alpha, RGB, or four
/// components), its alpha only when `SMaskInData` asks for it and opaque otherwise; with a count, the first that
/// many components are delivered as they are. Not applied: the resolution reduction pdf.js asks for on
/// images larger than 2048 samples (`reducePower`); the image is delivered at full size.
fn jpx_pixels(bytes: &[u8], options: JpxOptions) -> Result<Vec<u8>> {
    let image = jpx::parse(bytes).map_err(|e| PdfError::Unknown(e.message().to_owned()))?;
    let decoded = jpx::output::decode(
        &image,
        jpx::output::Options {
            ignore_palette: options.is_indexed,
        },
    )
    .map_err(|e| PdfError::Unknown(e.message().to_owned()))?;
    if options.num_components > 0 && !options.smask_in_data {
        return Ok(decoded.to_pixels(options.num_components).data);
    }
    let pixels = decoded.to_pixels(4);
    let count = pixels.components as usize;
    let alpha = |value: u8| if options.smask_in_data { value } else { 255 };
    let mut out = Vec::with_capacity(pixels.data.len() / count.max(1) * 4);
    for pixel in pixels.data.chunks_exact(count.max(1)) {
        match count {
            1 => out.extend_from_slice(&[pixel[0], pixel[0], pixel[0], 255]),
            2 => out.extend_from_slice(&[pixel[0], pixel[0], pixel[0], alpha(pixel[1])]),
            3 => out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]),
            _ => out.extend_from_slice(&[pixel[0], pixel[1], pixel[2], alpha(pixel[3])]),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_largest_component_value_follows_javascript_shifts() {
        assert_eq!(max_value(1), 1.0);
        assert_eq!(max_value(8), 255.0);
        assert_eq!(max_value(16), 65535.0);
        // `1 << 32` is 1 in JavaScript
        assert_eq!(max_value(32), 0.0);
    }

    #[test]
    fn buffer_lengths_refuse_what_a_typed_array_refuses() {
        assert_eq!(buffer_length(&[3, 4, 5]).ok(), Some(60));
        assert!(buffer_length(&[1 << 20, 1 << 20]).is_err());
        assert!(buffer_length(&[usize::MAX, 2]).is_err());
    }

    #[test]
    fn the_size_marker_of_a_jpx_stream_is_found_by_scanning() {
        let mut bytes = vec![0x00, 0x01, 0xff, 0x4f, 0xff, 0x51, 0x00, 0x2f, 0x00, 0x00];
        for value in [640u32, 480, 16, 8] {
            bytes.extend(value.to_be_bytes());
        }
        bytes.extend([0u8; 16]);
        bytes.extend([0x00, 0x03]);
        let (width, height, components) = parse_jpx_properties(&bytes).expect("a size marker");
        assert_eq!((width, height, components), (624.0, 472.0, 3));
        assert!(parse_jpx_properties(&[1, 2, 3]).is_err());
    }

    #[test]
    fn leading_bytes_before_the_start_of_image_are_skipped() {
        assert_eq!(skip_useless_bytes(&[1, 2, 0xff, 0xd8, 3]), &[0xff, 0xd8, 3]);
        assert_eq!(skip_useless_bytes(&[1, 2, 3]), &[1, 2, 3]);
    }

    #[test]
    fn a_comps_store_truncates_and_drops_what_does_not_fit() {
        let mut comps = Comps::U8(vec![0, 0]);
        comps.set(0, 7.9);
        comps.set(1, f64::NAN);
        comps.set(5, 1.0);
        assert_eq!((comps.get(0), comps.get(1)), (7.0, 0.0));
        assert!(comps.get(5).is_nan());
        assert_eq!(comps.len(), 2);
    }
}
