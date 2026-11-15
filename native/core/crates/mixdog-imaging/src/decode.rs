//! Decoding, as sharp (libvips) does it for the five formats the image calls meet: JPEG, PNG, GIF (first frame),
//! WebP (lossy, lossless and animated: first frame) and TIFF. The format is sniffed from the bytes, never from the
//! extension.
//!
//! What comes out is always 8-bit RGB or RGBA in sRGB: libvips converts grey to RGB, palette and 16-bit to 8-bit
//! truecolour and an ICC-tagged image to sRGB before it resizes or re-encodes. The metadata width and height are the
//! stored ones (not rotated by the EXIF orientation, which sharp ignores unless asked), and the orientation is
//! exposed for the callers that rotate. The whole image is decoded once: a corrupt stream that the header does not
//! show is rejected here, as `decodedImageMeta` does, and the pixel limit is enforced before any pixel is read.
//!
//! SVG buffers are rasterized through resvg. AVIF/HEIF decoding remains a parity
//! blocker: sharp accepts them even when a caller labels the bytes as PNG. Native
//! image routing must wait for that gap; it is not an intentional removal.

use std::io::Cursor;

use image::ColorType;
use image::ImageDecoder;
use image::ImageError;
use image::Limits;
use image::codecs::gif::GifDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::tiff::TiffDecoder;
use image::codecs::webp::WebPDecoder;
use image::metadata::Orientation;
use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;
use zune_jpeg::errors::DecodeErrors;

use crate::color;
use crate::color::CmykConverter;
use crate::error::EMPTY_BUFFER;
use crate::error::ImagingError;
use crate::error::PIXEL_LIMIT;
use crate::error::UNSUPPORTED_FORMAT;
use crate::error::corrupt_header;
use crate::error::PNG_READ;

/// `limitInputPixels` of `decodedImageMeta`: 64 Mi pixels.
pub const DECODE_PIXEL_LIMIT: u64 = 64 * 1024 * 1024;

/// sharp's own default `limitInputPixels` (0x3FFF * 0x3FFF), which a call that names none runs under.
pub const DEFAULT_PIXEL_LIMIT: u64 = 0x3FFF * 0x3FFF;

/// The formats the decoder takes.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Format {
    Jpeg,
    Png,
    Gif,
    Webp,
    Tiff,
    Svg,
}

impl Format {
    /// What libvips sees in the first bytes.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            Some(Self::Jpeg)
        } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
            Some(Self::Png)
        } else if bytes.starts_with(b"GIF8") {
            Some(Self::Gif)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Self::Webp)
        } else if bytes.starts_with(&[b'I', b'I', 0x2A, 0x00])
            || bytes.starts_with(&[b'M', b'M', 0x00, 0x2A])
            || bytes.starts_with(&[b'I', b'I', 0x2B, 0x00])
            || bytes.starts_with(&[b'M', b'M', 0x00, 0x2B])
        {
            Some(Self::Tiff)
        } else if bytes.starts_with(&[0x1f, 0x8b]) || Self::looks_like_svg_text(bytes) {
            // XML (including declarations/comments) and SVGZ are parsed by usvg;
            // malformed SVG still fails the actual decode.
            Some(Self::Svg)
        } else {
            None
        }
    }

    /// Markup is taken as SVG only when `<svg` (any case) is in its first 1000 bytes, as libvips' svgload asks:
    /// other XML or HTML stays an unsupported image format, the sentence sharp gives for it.
    fn looks_like_svg_text(bytes: &[u8]) -> bool {
        let text = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        text.iter().copied().find(|byte| !byte.is_ascii_whitespace()) == Some(b'<')
            && bytes[..bytes.len().min(1000)].windows(4).any(|window| window.eq_ignore_ascii_case(b"<svg"))
    }

    /// sharp's `metadata().format`, which names the image type of a result: `image/<name>`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Tiff => "tiff",
            Self::Svg => "svg",
        }
    }
}

/// 8-bit pixels, RGB (3 bytes a pixel) or RGBA (4), row after row.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub data: Vec<u8>,
}

impl Raster {
    pub fn channels(&self) -> usize {
        if self.has_alpha { 4 } else { 3 }
    }

    /// The pixels as RGBA (alpha 255 where there is none).
    pub fn to_rgba(&self) -> Vec<u8> {
        if self.has_alpha {
            return self.data.clone();
        }
        let mut rgba = Vec::with_capacity(self.data.len() / 3 * 4);
        for pixel in self.data.chunks_exact(3) {
            rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
        }
        rgba
    }
}

/// A decoded image.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Decoded {
    pub format: Format,
    /// The stored width, not rotated by the orientation.
    pub width: u32,
    /// The stored height, not rotated by the orientation.
    pub height: u32,
    /// The EXIF orientation, 1 to 8 (1 when there is none): for a caller that rotates.
    pub orientation: u8,
    /// The pixels in sRGB.
    pub raster: Raster,
}

/// Where a failure happened, which decides the libvips sentence.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Header,
    Data,
}

/// The sentence libvips gives for a failure of `format` at `stage`: a header it cannot read is "corrupt header" with
/// the loader's own words; a failure inside the pixel data carries the loader's words alone (libpng and libjpeg), or
/// the same corrupt-header text (GIF and WebP, which libvips parses whole on opening).
fn corrupt(format: Format, stage: Stage) -> ImagingError {
    let sentence = match (format, stage) {
        (Format::Png, Stage::Data) => PNG_READ.to_owned(),
        (Format::Png, Stage::Header) => corrupt_header(""),
        (Format::Jpeg, Stage::Data) => JPEG_PREMATURE_END.to_owned(),
        (Format::Jpeg, Stage::Header) => corrupt_header(JPEG_PREMATURE_END),
        (Format::Gif, _) => corrupt_header("gifload_buffer: Unexpected end of GIF source data"),
        (Format::Webp, _) => corrupt_header("webp: unable to parse image"),
        (Format::Tiff, Stage::Header) => UNSUPPORTED_FORMAT.to_owned(),
        (Format::Tiff, Stage::Data) => "tiff2vips: read error".to_owned(),
        (Format::Svg, _) => corrupt_header("invalid SVG data"),
    };
    ImagingError::invalid(sentence)
}

const JPEG_PREMATURE_END: &str = "VipsJpeg: premature end of JPEG image";

fn image_error(format: Format, stage: Stage, error: &ImageError) -> ImagingError {
    match error {
        ImageError::Limits(_) => ImagingError::invalid(PIXEL_LIMIT),
        ImageError::Unsupported(_) => ImagingError::invalid(UNSUPPORTED_FORMAT),
        // An out-of-memory text is the machine's failure, not a judgement of the bytes (Node's `isEnvironmentError`).
        ImageError::IoError(io) => {
            let classified = ImagingError::from_message(&io.to_string());
            if classified.is_environment() { classified } else { corrupt(format, stage) }
        }
        _ => corrupt(format, stage),
    }
}

fn jpeg_error(error: &DecodeErrors, stage: Stage) -> ImagingError {
    match (error, stage) {
        (DecodeErrors::LargeDimensions(_), _) => ImagingError::invalid(PIXEL_LIMIT),
        (DecodeErrors::HuffmanDecode(_) | DecodeErrors::DqtError(_), _) => {
            ImagingError::invalid(corrupt_header("VipsJpeg: Bogus Huffman table definition"))
        }
        _ => corrupt(Format::Jpeg, stage),
    }
}

fn check_pixels(width: u32, height: u32, limit: u64) -> Result<(), ImagingError> {
    if u64::from(width) * u64::from(height) > limit { Err(ImagingError::invalid(PIXEL_LIMIT)) } else { Ok(()) }
}

/// Decodes `bytes` (the whole image, every pixel) and refuses an image of more than `pixel_limit` pixels.
pub fn decode(bytes: &[u8], pixel_limit: u64) -> Result<Decoded, ImagingError> {
    if bytes.is_empty() {
        return Err(ImagingError::invalid(EMPTY_BUFFER));
    }
    match Format::sniff(bytes) {
        None => Err(ImagingError::invalid(UNSUPPORTED_FORMAT)),
        Some(Format::Jpeg) => decode_jpeg(bytes, pixel_limit),
        Some(Format::Png) => decode_with(PngDecoder::new(Cursor::new(bytes)), Format::Png, pixel_limit),
        Some(Format::Gif) => decode_with(GifDecoder::new(Cursor::new(bytes)), Format::Gif, pixel_limit),
        Some(Format::Webp) => decode_with(WebPDecoder::new(Cursor::new(bytes)), Format::Webp, pixel_limit),
        Some(Format::Tiff) => decode_tiff(bytes, pixel_limit),
        Some(Format::Svg) => decode_svg(bytes, pixel_limit),
    }
}

/// SVG metadata uses sharp's default density (72 DPI). The raster retains straight
/// alpha like the other decoders; tiny-skia renders premultiplied sRGB.
fn decode_svg(bytes: &[u8], pixel_limit: u64) -> Result<Decoded, ImagingError> {
    use std::sync::{Arc, OnceLock};
    use resvg::{tiny_skia, usvg};
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    let fonts = FONTS.get_or_init(|| {
        let mut fonts = usvg::fontdb::Database::new();
        fonts.load_system_fonts();
        Arc::new(fonts)
    }).clone();
    let options = usvg::Options {
        dpi: 72.0,
        fontdb: fonts,
        // A buffer has no base URL. Embedded data images are handled by usvg;
        // do not resolve relative paths against the worker's current directory.
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_string: Box::new(|_, _| None),
            ..usvg::ImageHrefResolver::default()
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_data(bytes, &options)
        .map_err(|_| corrupt(Format::Svg, Stage::Header))?;
    let size = tree.size().to_int_size();
    let (width, height) = (size.width(), size.height());
    check_pixels(width, height, pixel_limit)?;
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| ImagingError::environment("cannot allocate SVG raster"))?;
    resvg::render(&tree, tiny_skia::Transform::identity(), &mut pixmap.as_mut());
    // The straight colour is the premultiplied byte over the alpha, truncated: what libvips writes when it takes
    // the rasterizer's premultiplied pixels back to straight alpha (tiny-skia's own demultiply rounds).
    let data = pixmap.pixels().iter().flat_map(|pixel| {
        let alpha = u32::from(pixel.alpha());
        let straight = |channel: u8| if alpha == 0 { 0 } else { (u32::from(channel) * 255 / alpha).min(255) as u8 };
        [straight(pixel.red()), straight(pixel.green()), straight(pixel.blue()), pixel.alpha()]
    }).collect();
    let raster = Raster { width, height, has_alpha: true, data };
    Ok(Decoded { format: Format::Svg, width, height, orientation: 1, raster })
}

/// The dimensions of the image after one full decode: sharp's `decodedImageMeta`.
pub fn decoded_dimensions(bytes: &[u8]) -> Result<(u32, u32), ImagingError> {
    decode(bytes, DECODE_PIXEL_LIMIT).map(|decoded| (decoded.width, decoded.height))
}

/// A TIFF whose strips are JPEG-compressed YCbCr is read here: the `image` crate refuses that colour type. The
/// strips come out as YCbCr samples, which libjpeg (what libvips asks for RGB) turns into RGB with its fixed-point
/// tables, reproduced below. Every other TIFF goes through the `image` decoder.
fn decode_tiff(bytes: &[u8], pixel_limit: u64) -> Result<Decoded, ImagingError> {
    use tiff::decoder::Decoder;
    use tiff::decoder::DecodingResult;
    use tiff::decoder::Limits as TiffLimits;
    use tiff::tags::Tag;
    use tiff::ColorType as TiffColor;

    let mut reader = match Decoder::new(Cursor::new(bytes)) {
        Ok(reader) => reader.with_limits(TiffLimits::unlimited()),
        Err(_) if jpeg_tables_cut_off(bytes) => return Err(ImagingError::invalid(JPEG_TABLES_MISSING)),
        Err(_) => return decode_with(TiffDecoder::new(Cursor::new(bytes)), Format::Tiff, pixel_limit),
    };
    if !matches!(reader.colortype(), Ok(TiffColor::YCbCr(8))) {
        return decode_with(TiffDecoder::new(Cursor::new(bytes)), Format::Tiff, pixel_limit);
    }
    let (width, height) = reader.dimensions().map_err(|_| corrupt(Format::Tiff, Stage::Header))?;
    if width == 0 || height == 0 {
        return Err(corrupt(Format::Tiff, Stage::Header));
    }
    check_pixels(width, height, pixel_limit)?;
    let orientation = reader.find_tag_unsigned::<u8>(Tag::Orientation).ok().flatten().filter(|value| (1..=8).contains(value)).unwrap_or(1);
    let icc = reader.get_tag_u8_vec(Tag::IccProfile).ok();
    let samples = match reader.read_image() {
        Ok(DecodingResult::U8(samples)) => samples,
        _ => return Err(corrupt(Format::Tiff, Stage::Data)),
    };
    if samples.len() != width as usize * height as usize * 3 {
        return Err(corrupt(Format::Tiff, Stage::Data));
    }
    let mut data = Vec::with_capacity(samples.len());
    for pixel in samples.chunks_exact(3) {
        data.extend_from_slice(&ycbcr_to_rgb(pixel[0], pixel[1], pixel[2]));
    }
    let mut raster = Raster { width, height, has_alpha: false, data };
    if let Some(icc) = icc.as_deref().filter(|icc| !icc.is_empty()) {
        color::rgb_to_srgb(&mut raster.data, false, icc);
    }
    Ok(Decoded { format: Format::Tiff, width, height, orientation, raster })
}

/// What libjpeg says inside libtiff when the shared tables of a JPEG-in-TIFF file (the `JPEGTables` tag) lie beyond
/// the end of the data: the strips then have no quantization table to use.
const JPEG_TABLES_MISSING: &str = "tiff2vips: Quantization table 0x00 was not defined";

/// Whether the first directory of a classic TIFF says its strips are JPEG-compressed and puts the value of its
/// `JPEGTables` entry where the data does not reach.
fn jpeg_tables_cut_off(bytes: &[u8]) -> bool {
    let little = match bytes.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return false,
    };
    let read16 = |at: usize| bytes.get(at..at + 2).map(|pair| if little { u16::from_le_bytes([pair[0], pair[1]]) } else { u16::from_be_bytes([pair[0], pair[1]]) });
    let read32 = |at: usize| {
        bytes.get(at..at + 4).map(|quad| {
            let quad = [quad[0], quad[1], quad[2], quad[3]];
            if little { u32::from_le_bytes(quad) } else { u32::from_be_bytes(quad) }
        })
    };
    if read16(2) != Some(42) {
        return false;
    }
    let Some(directory) = read32(4).map(|offset| offset as usize) else { return false };
    let Some(entries) = read16(directory) else { return false };
    let (mut compression, mut tables_end) = (None, None);
    for index in 0..usize::from(entries) {
        let at = directory + 2 + index * 12;
        let (Some(tag), Some(count), Some(value)) = (read16(at), read32(at + 4), read32(at + 8)) else { return false };
        match tag {
            259 => compression = read16(at + 8),
            347 if count > 4 => tables_end = Some(u64::from(value) + u64::from(count)),
            _ => {}
        }
    }
    compression == Some(7) && tables_end.is_some_and(|end| end > bytes.len() as u64)
}

/// libjpeg's YCbCr to RGB (`jdcolor.c`): 16-bit fixed point with the same rounding.
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8) -> [u8; 3] {
    const SCALE: i32 = 16;
    const HALF: i32 = 1 << (SCALE - 1);
    let fix = |value: f64| (value * f64::from(1 << SCALE) + 0.5) as i32;
    let (y, cb, cr) = (i32::from(y), i32::from(cb) - 128, i32::from(cr) - 128);
    let red = y + ((fix(1.402) * cr + HALF) >> SCALE);
    let green = y + ((-fix(0.34414) * cb + HALF - fix(0.71414) * cr) >> SCALE);
    let blue = y + ((fix(1.772) * cb + HALF) >> SCALE);
    [red.clamp(0, 255) as u8, green.clamp(0, 255) as u8, blue.clamp(0, 255) as u8]
}

fn decode_with<D: ImageDecoder>(opened: Result<D, ImageError>, format: Format, pixel_limit: u64) -> Result<Decoded, ImagingError> {
    let mut decoder = opened.map_err(|error| image_error(format, Stage::Header, &error))?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 {
        return Err(corrupt(format, Stage::Header));
    }
    check_pixels(width, height, pixel_limit)?;
    // The pixel limit above is the only bound, as for libvips: the TIFF reader's own default caps its buffers at
    // 256 MiB, which a 16-bit image under the limit can exceed.
    decoder.set_limits(Limits::no_limits()).map_err(|error| image_error(format, Stage::Header, &error))?;
    let color = decoder.color_type();
    let icc = decoder.icc_profile().ok().flatten();
    let orientation = decoder.orientation().map(Orientation::to_exif).unwrap_or(1);
    let total = usize::try_from(decoder.total_bytes()).map_err(|_| ImagingError::invalid(PIXEL_LIMIT))?;
    let mut buffer = vec![0u8; total];
    decoder.read_image(&mut buffer).map_err(|error| image_error(format, Stage::Data, &error))?;
    let mut raster = raster_of(color, buffer, width, height)?;
    if let Some(icc) = icc.as_deref().filter(|icc| !icc.is_empty()) {
        color::rgb_to_srgb(&mut raster.data, raster.has_alpha, icc);
    }
    Ok(Decoded { format, width, height, orientation, raster })
}

/// 8-bit RGB or RGBA from what a decoder read: grey is spread over the three channels and 16-bit samples keep their
/// high byte (native-endian, as the decoders write them).
fn raster_of(color: ColorType, data: Vec<u8>, width: u32, height: u32) -> Result<Raster, ImagingError> {
    let high = |pair: &[u8]| (u16::from_ne_bytes([pair[0], pair[1]]) >> 8) as u8;
    let (has_alpha, data) = match color {
        ColorType::Rgb8 => (false, data),
        ColorType::Rgba8 => (true, data),
        ColorType::L8 => (false, data.iter().flat_map(|&v| [v, v, v]).collect()),
        ColorType::La8 => (true, data.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect()),
        ColorType::L16 => (false, data.chunks_exact(2).flat_map(|p| [high(p); 3]).collect()),
        ColorType::La16 => (true, data.chunks_exact(4).flat_map(|p| [high(&p[..2]), high(&p[..2]), high(&p[..2]), high(&p[2..])]).collect()),
        ColorType::Rgb16 => (false, data.chunks_exact(2).map(high).collect()),
        ColorType::Rgba16 => (true, data.chunks_exact(2).map(high).collect()),
        _ => return Err(ImagingError::invalid(UNSUPPORTED_FORMAT)),
    };
    let raster = Raster { width, height, has_alpha, data };
    if raster.data.len() != width as usize * height as usize * raster.channels() {
        return Err(ImagingError::invalid(UNSUPPORTED_FORMAT));
    }
    Ok(raster)
}

/// Whether the file carries an Adobe APP14 marker, which means its CMYK inks are stored inverted.
fn has_adobe_marker(bytes: &[u8]) -> bool {
    let mut at = 2;
    while at + 4 <= bytes.len() && bytes[at] == 0xFF {
        let marker = bytes[at + 1];
        if marker == 0xFF {
            at += 1;
            continue;
        }
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            at += 2;
            continue;
        }
        if marker == 0xDA {
            return false;
        }
        let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
        if marker == 0xEE && length >= 7 && bytes.get(at + 4..at + 9) == Some(b"Adobe".as_slice()) {
            return true;
        }
        at += 2 + length;
    }
    false
}

/// Whether the stream ends with an end-of-image marker after its last scan. libjpeg warns "premature end of JPEG
/// file" when the data runs out before it, and sharp fails on a warning, so a truncated file is refused even when
/// every row it holds decoded.
fn has_end_of_image(bytes: &[u8]) -> bool {
    let mut at = 2;
    let mut in_scan = false;
    while at + 1 < bytes.len() {
        if bytes[at] != 0xFF {
            if in_scan {
                at += 1;
                continue;
            }
            return false;
        }
        let marker = bytes[at + 1];
        match marker {
            0xFF => at += 1,
            0x00 | 0xD0..=0xD7 => at += 2,
            0xD9 => return true,
            0xD8 | 0x01 => at += 2,
            _ => {
                if at + 4 > bytes.len() {
                    return false;
                }
                let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
                at += 2 + length.max(2);
                in_scan |= marker == 0xDA;
            }
        }
    }
    false
}

fn decode_jpeg(bytes: &[u8], pixel_limit: u64) -> Result<Decoded, ImagingError> {
    // A truncated or damaged stream is an error, as it is for sharp (which fails on libjpeg warnings).
    let options = DecoderOptions::default().set_strict_mode(true).set_max_width(usize::from(u16::MAX)).set_max_height(usize::from(u16::MAX));
    let mut header = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    header.decode_headers().map_err(|error| jpeg_error(&error, Stage::Header))?;
    let info = header.info().ok_or_else(|| corrupt(Format::Jpeg, Stage::Header))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    if width == 0 || height == 0 {
        return Err(corrupt(Format::Jpeg, Stage::Header));
    }
    check_pixels(width, height, pixel_limit)?;
    let input = header.input_colorspace().unwrap_or(ColorSpace::Unknown);
    let icc = header.icc_profile().filter(|icc| !icc.is_empty());
    let orientation = header.exif().and_then(|exif| Orientation::from_exif_chunk(exif)).map(Orientation::to_exif).unwrap_or(1);
    let cmyk = if input == ColorSpace::CMYK { icc.as_deref().and_then(CmykConverter::new) } else { None };
    let output = match input {
        ColorSpace::Luma => ColorSpace::Luma,
        ColorSpace::CMYK if cmyk.is_some() => ColorSpace::CMYK,
        _ => ColorSpace::RGB,
    };
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options.jpeg_set_out_colorspace(output));
    let pixels = decoder.decode().map_err(|error| jpeg_error(&error, Stage::Data))?;
    if !has_end_of_image(bytes) {
        return Err(corrupt(Format::Jpeg, Stage::Data));
    }
    let expected = width as usize * height as usize;
    let raster = match (output, &cmyk) {
        (ColorSpace::Luma, _) if pixels.len() == expected => {
            Raster { width, height, has_alpha: false, data: pixels.iter().flat_map(|&v| [v, v, v]).collect() }
        }
        (ColorSpace::CMYK, Some(converter)) if pixels.len() == expected * 4 => {
            let data = converter.convert(&pixels, has_adobe_marker(bytes)).ok_or_else(|| corrupt(Format::Jpeg, Stage::Data))?;
            Raster { width, height, has_alpha: false, data }
        }
        (ColorSpace::RGB, _) if pixels.len() == expected * 3 => {
            let mut data = pixels;
            // A CMYK file read as RGB has no RGB profile to apply.
            let rgb_profile = if input == ColorSpace::CMYK || input == ColorSpace::YCCK { None } else { icc.as_deref() };
            if let Some(icc) = rgb_profile {
                color::rgb_to_srgb(&mut data, false, icc);
            }
            Raster { width, height, has_alpha: false, data }
        }
        _ => return Err(corrupt(Format::Jpeg, Stage::Data)),
    };
    Ok(Decoded { format: Format::Jpeg, width, height, orientation, raster })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_format_is_sniffed_from_the_bytes() {
        assert_eq!(Format::sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(Format::Jpeg));
        assert_eq!(Format::sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]), Some(Format::Png));
        assert_eq!(Format::sniff(b"GIF89a"), Some(Format::Gif));
        assert_eq!(Format::sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some(Format::Webp));
        assert_eq!(Format::sniff(b"II*\0\x08\0\0\0"), Some(Format::Tiff));
        assert_eq!(Format::sniff(b"MM\0*\0\0\0\x08"), Some(Format::Tiff));
        assert_eq!(Format::sniff(b"RIFF\x10\0\0\0WAVEfmt "), None);
        assert_eq!(Format::sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some(Format::Svg));
        assert_eq!(Format::sniff(b"<?xml version=\"1.0\"?>\n<!-- c --><SVG/>"), Some(Format::Svg));
        assert_eq!(Format::sniff(b"<!doctype html><html><body>not an image</body></html>"), None);
        assert_eq!(Format::sniff(b"<?xml version=\"1.0\"?><note/>"), None);
        assert_eq!(Format::sniff(b"\0\0\0\x1cftypavif"), None);
        assert_eq!(Format::sniff(b""), None);
    }

    #[test]
    fn an_empty_buffer_is_sharps_empty_buffer_error() {
        assert_eq!(decode(b"", DECODE_PIXEL_LIMIT).unwrap_err().sentence(), EMPTY_BUFFER);
    }

    #[test]
    fn bytes_that_are_no_image_are_unsupported() {
        let error = decode(b"hello world this is not an image", DECODE_PIXEL_LIMIT).unwrap_err();
        assert_eq!(error.sentence(), UNSUPPORTED_FORMAT);
        assert!(!error.is_environment());
    }

    #[test]
    fn a_png_header_is_enough_to_refuse_a_pixel_count_over_the_limit() {
        // A 1x1 PNG whose IHDR says 8200x8200 (67.24 M pixels): refused before any pixel is read.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        png.extend_from_slice(&8200u32.to_be_bytes());
        png.extend_from_slice(&8200u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        let error = decode(&png, DECODE_PIXEL_LIMIT).unwrap_err();
        assert!(error.sentence() == PIXEL_LIMIT || error.sentence().starts_with("Input buffer has corrupt header"), "{error}");
    }

    #[test]
    fn grey_and_sixteen_bit_samples_become_eight_bit_rgb() {
        let grey = raster_of(ColorType::L8, vec![10, 200], 2, 1).unwrap();
        assert_eq!((grey.has_alpha, grey.data.as_slice()), (false, [10, 10, 10, 200, 200, 200].as_slice()));
        let grey_alpha = raster_of(ColorType::La8, vec![10, 99], 1, 1).unwrap();
        assert_eq!((grey_alpha.has_alpha, grey_alpha.data.as_slice()), (true, [10, 10, 10, 99].as_slice()));
        let wide: Vec<u8> = [0x1234u16, 0xFFFF, 0x0000].iter().flat_map(|v| v.to_ne_bytes()).collect();
        let rgb = raster_of(ColorType::Rgb16, wide, 1, 1).unwrap();
        assert_eq!(rgb.data, [0x12, 0xFF, 0x00]);
        assert!(raster_of(ColorType::Rgb32F, vec![0; 12], 1, 1).is_err());
        assert!(raster_of(ColorType::Rgb8, vec![0; 5], 1, 1).is_err());
    }

    #[test]
    fn an_adobe_marker_is_found_before_the_scan() {
        let with = [0xFF, 0xD8, 0xFF, 0xEE, 0x00, 0x0E, b'A', b'd', b'o', b'b', b'e', 0, 100, 0, 0, 0, 0, 2, 0xFF, 0xDA, 0, 2];
        let without = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0, 0, 0xFF, 0xDA, 0, 2];
        assert!(has_adobe_marker(&with));
        assert!(!has_adobe_marker(&without));
    }

    #[test]
    fn raster_to_rgba_adds_an_opaque_alpha() {
        let raster = Raster { width: 1, height: 2, has_alpha: false, data: vec![1, 2, 3, 4, 5, 6] };
        assert_eq!(raster.to_rgba(), [1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn svg_buffers_decode_pixels_and_keep_straight_alpha() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="#336699" fill-opacity="0.5"/></svg>"##;
        let decoded = decode(svg, 12).unwrap();
        assert_eq!((decoded.width, decoded.height, decoded.format), (4, 3, Format::Svg));
        let pixel = &decoded.raster.data[..4];
        for (actual, expected) in pixel.iter().zip([51u8, 102, 153, 128]) {
            assert!(actual.abs_diff(expected) <= 1, "{pixel:?}");
        }
        assert_eq!(decode(svg, 11).unwrap_err().sentence(), PIXEL_LIMIT);
    }

    #[test]
    fn svg_physical_dimensions_use_sharps_default_density() {
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in"/>"#;
        let decoded = decode(svg, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((decoded.width, decoded.height), (72, 72));
    }

    #[test]
    fn a_jpeg_without_its_end_of_image_marker_is_truncated() {
        let whole = [0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x03, 0x01, 0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD9];
        assert!(has_end_of_image(&whole));
        assert!(!has_end_of_image(&whole[..whole.len() - 2]));
        // An FFD9 inside a marker segment (an embedded thumbnail) is not the end of the image.
        let inside = [0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x06, 0xFF, 0xD9, 0x00, 0x00, 0xFF, 0xDA, 0x00, 0x03, 0x01, 0x12, 0x34];
        assert!(!has_end_of_image(&inside));
    }

    #[test]
    fn ycbcr_greys_stay_grey_and_the_extremes_clamp() {
        for value in [0u8, 17, 128, 255] {
            assert_eq!(ycbcr_to_rgb(value, 128, 128), [value; 3]);
        }
        assert_eq!(ycbcr_to_rgb(255, 255, 255), [255, 121, 255]);
        assert_eq!(ycbcr_to_rgb(0, 0, 0), [0, 135, 0]);
        assert!(!jpeg_tables_cut_off(b"not a tiff"));
    }
}
