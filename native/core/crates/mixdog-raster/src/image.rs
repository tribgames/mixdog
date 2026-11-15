//! The image type: straight-alpha RGBA8 pixels plus the band layout sharp reports for them.
//!
//! Pixels are always stored as RGBA, row after row; a grey image has red = green = blue. `channels` is the number of
//! bands sharp would show (1 grey, 2 grey and alpha, 3 RGB, 4 RGBA), so [`Image::to_raw`] and [`Image::metadata`]
//! answer what `raw()` and `metadata()` do. Decoding is `mixdog-imaging`'s (one decoder for the product): the
//! metadata width and height are the stored ones, not rotated by the EXIF orientation, and the orientation is
//! applied only by [`Image::auto_orient`] (sharp's `rotate()` with no angle).

use ::image::ExtendedColorType;
use ::image::ImageEncoder;
use ::image::codecs::png::CompressionType;
use ::image::codecs::png::FilterType;
use ::image::codecs::png::PngEncoder;
use mixdog_imaging::DEFAULT_PIXEL_LIMIT;
use mixdog_imaging::Format;
use mixdog_imaging::Raster;

use crate::RasterError;

/// sharp's default PNG compression level.
const PNG_COMPRESSION_LEVEL: u8 = 6;

/// What `sharp(input).metadata()` answers.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Metadata {
    /// The image type of the decoded input (`jpeg`, `png`, `gif`, `webp`, `tiff`); `None` for raw or created pixels.
    pub format: Option<&'static str>,
    pub width: u32,
    pub height: u32,
    pub channels: u8,
    pub has_alpha: bool,
    /// Pixels per inch, when the file states a resolution above 1 pixel per millimetre.
    pub density: Option<u32>,
    /// The EXIF orientation, 2 to 8, when the file carries one other than the identity.
    pub orientation: Option<u8>,
}

/// Straight-alpha RGBA8 pixels.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Image {
    width: u32,
    height: u32,
    channels: u8,
    format: Option<Format>,
    density: Option<u32>,
    orientation: u8,
    data: Vec<u8>,
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    bytes.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

/// libvips's resolution of a file that states none: 72 pixels per inch (2.835 per millimetre).
const DEFAULT_DENSITY: u32 = 72;

/// The band count and resolution a PNG's header states: colour type, `tRNS` (libvips adds an alpha band for it) and
/// `pHYs` (a stated resolution of exactly 1 pixel per millimetre is libvips's own "none"; a file without one reads as 72 dpi).
fn png_facts(bytes: &[u8]) -> (Option<u8>, Option<u32>) {
    let mut colour_type = None;
    let mut transparency = false;
    let mut density = Some(DEFAULT_DENSITY);
    let mut at = 8usize;
    while let (Some(length), Some(kind)) = (be32(bytes, at), bytes.get(at + 4..at + 8)) {
        let body = at + 8;
        match kind {
            b"IHDR" => colour_type = bytes.get(body + 9).copied(),
            b"tRNS" => transparency = true,
            b"pHYs" => {
                if let (Some(per_metre), Some(1)) = (be32(bytes, body), bytes.get(body + 8).copied()) {
                    let per_millimetre = f64::from(per_metre) / 1000.0;
                    density = if (per_millimetre - 1.0).abs() < 1e-9 { None } else { Some((per_millimetre * 25.4).round() as u32) };
                }
            }
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        at = body.saturating_add(length as usize).saturating_add(4);
    }
    let channels = colour_type.and_then(|colour| match colour {
        0 => Some(if transparency { 2 } else { 1 }),
        2 | 3 => Some(if transparency { 4 } else { 3 }),
        4 => Some(2),
        6 => Some(4),
        _ => None,
    });
    (channels, density)
}

/// The component count and the resolution of a JPEG: the JFIF density in dots per inch or centimetre; a file with
/// neither a JFIF nor an EXIF segment reads as 72 dpi, and one with only EXIF (whose resolution tags are not read here)
/// states none.
fn jpeg_facts(bytes: &[u8]) -> (Option<u8>, Option<u32>) {
    let mut components = None;
    let mut density = None;
    let mut exif = false;
    let mut jfif = false;
    let mut at = 2usize;
    while bytes.get(at) == Some(&0xFF) {
        let Some(&marker) = bytes.get(at + 1) else { break };
        if marker == 0xFF {
            at += 1;
            continue;
        }
        let Some(length) = be16(bytes, at + 2) else { break };
        let body = at + 4;
        if marker == 0xE0 && bytes.get(body..body + 5) == Some(&b"JFIF\0"[..]) {
            let units = bytes.get(body + 7).copied().unwrap_or(0);
            let x = f64::from(be16(bytes, body + 8).unwrap_or(0));
            let per_inch = match units {
                1 => x,
                2 => x * 2.54,
                _ => 0.0,
            };
            if per_inch > 0.0 {
                density = Some(per_inch.round() as u32);
            }
        }
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            components = bytes.get(body + 5).copied();
        }
        if marker == 0xDA {
            break;
        }
        at = at.saturating_add(2 + usize::from(length));
    }
    if !jfif && !exif {
        density = Some(DEFAULT_DENSITY);
    }
    (components, density)
}

/// True when every pixel has red = green = blue.
fn is_grey(raster: &Raster) -> bool {
    raster.data.chunks_exact(raster.channels()).all(|p| p[0] == p[1] && p[1] == p[2])
}

impl Image {
    /// Decodes PNG, JPEG, GIF (first frame), WebP or TIFF bytes under sharp's default pixel limit.
    pub fn decode(bytes: &[u8]) -> Result<Self, RasterError> {
        let decoded = mixdog_imaging::decode(bytes, DEFAULT_PIXEL_LIMIT).map_err(|error| RasterError::new(error.to_string()))?;
        let raster = &decoded.raster;
        let from_pixels = if raster.has_alpha { 4 } else { 3 };
        let (header_channels, density) = match decoded.format {
            Format::Png => png_facts(bytes),
            Format::Jpeg => jpeg_facts(bytes),
            _ => (None, None),
        };
        // A header band count is trusted only where it agrees with the pixels the decoder produced (a grey source
        // has no colour, a palette or colour-keyed source has an alpha band when it has transparency).
        let channels = match header_channels {
            Some(count) if (count == 2 || count == 4) == raster.has_alpha && (count >= 3 || is_grey(raster)) => count,
            _ => from_pixels,
        };
        Ok(Self {
            width: raster.width,
            height: raster.height,
            channels,
            format: Some(decoded.format),
            density,
            orientation: decoded.orientation,
            data: raster.to_rgba(),
        })
    }

    /// `sharp(buffer, { raw: { width, height, channels } })`: packed 1 to 4 band pixels.
    pub fn from_raw(width: u32, height: u32, channels: u8, bytes: &[u8]) -> Result<Self, RasterError> {
        if !(1..=4).contains(&channels) {
            return Err(RasterError::new(format!("Expected channels to be 1, 2, 3 or 4 but received {channels}")));
        }
        let bands = usize::from(channels);
        let pixels = width as usize * height as usize;
        if width == 0 || height == 0 || bytes.len() != pixels * bands {
            return Err(RasterError::new("Expected positive width and height and a buffer of width * height * channels bytes for raw input"));
        }
        let mut data = Vec::with_capacity(pixels * 4);
        for pixel in bytes.chunks_exact(bands) {
            data.extend_from_slice(&match channels {
                1 => [pixel[0], pixel[0], pixel[0], 255],
                2 => [pixel[0], pixel[0], pixel[0], pixel[1]],
                3 => [pixel[0], pixel[1], pixel[2], 255],
                _ => [pixel[0], pixel[1], pixel[2], pixel[3]],
            });
        }
        Ok(Self::from_rgba(width, height, channels, data))
    }

    /// `sharp({ create: { width, height, channels, background } })`.
    pub fn create(width: u32, height: u32, channels: u8, background: [u8; 4]) -> Result<Self, RasterError> {
        if !(3..=4).contains(&channels) || width == 0 || height == 0 {
            return Err(RasterError::new("Expected positive width and height and 3 or 4 channels for create"));
        }
        let background = if channels == 3 { [background[0], background[1], background[2], 255] } else { background };
        let data = background.iter().copied().cycle().take(width as usize * height as usize * 4).collect();
        Ok(Self::from_rgba(width, height, channels, data))
    }

    /// Pixels already in RGBA (a grey image has red = green = blue): `data` is `width * height * 4` bytes.
    pub(crate) fn from_rgba(width: u32, height: u32, channels: u8, data: Vec<u8>) -> Self {
        debug_assert_eq!(data.len(), width as usize * height as usize * 4);
        Self { width, height, channels, format: None, density: None, orientation: 1, data }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// 1 grey, 2 grey and alpha, 3 RGB, 4 RGBA.
    pub fn channels(&self) -> u8 {
        self.channels
    }

    pub fn has_alpha(&self) -> bool {
        self.channels == 2 || self.channels == 4
    }

    /// The pixels as straight-alpha RGBA, row after row.
    pub fn rgba(&self) -> &[u8] {
        &self.data
    }

    pub fn metadata(&self) -> Metadata {
        Metadata {
            format: self.format.map(Format::name),
            width: self.width,
            height: self.height,
            channels: self.channels,
            has_alpha: self.has_alpha(),
            density: self.density,
            orientation: (self.orientation > 1).then_some(self.orientation),
        }
    }

    /// `raw().toBuffer()`: the bands packed as `channels` says.
    pub fn to_raw(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.data.len());
        for pixel in self.data.chunks_exact(4) {
            match self.channels {
                1 => out.push(pixel[0]),
                2 => out.extend_from_slice(&[pixel[0], pixel[3]]),
                3 => out.extend_from_slice(&pixel[..3]),
                _ => out.extend_from_slice(pixel),
            }
        }
        out
    }

    /// `png().toBuffer()`: sharp's defaults (zlib level 6, no row filter, no palette). Output is converted to sRGB, so a
    /// grey image is written as RGB (grey and alpha as RGBA), as sharp writes it.
    pub fn to_png(&self) -> Result<Vec<u8>, RasterError> {
        let (bytes, color) = if self.has_alpha() {
            (self.data.clone(), ExtendedColorType::Rgba8)
        } else {
            (self.data.chunks_exact(4).flat_map(|pixel| [pixel[0], pixel[1], pixel[2]]).collect(), ExtendedColorType::Rgb8)
        };
        let mut out = Vec::new();
        PngEncoder::new_with_quality(&mut out, CompressionType::Level(PNG_COMPRESSION_LEVEL), FilterType::NoFilter)
            .write_image(&bytes, self.width, self.height, color)
            .map_err(|error| RasterError::new(format!("the image could not be encoded: {error}")))?;
        Ok(out)
    }

    /// `ensureAlpha()`: an opaque alpha band when there is none.
    pub fn ensure_alpha(&self) -> Self {
        let mut out = self.clone();
        if !out.has_alpha() {
            out.channels += 1;
        }
        out
    }

    /// `removeAlpha()`: the alpha band is dropped, the colour left as it is.
    pub fn remove_alpha(&self) -> Self {
        let mut out = self.clone();
        if out.has_alpha() {
            out.channels -= 1;
            for pixel in out.data.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        out
    }

    /// `flatten({ background })`: the alpha band is blended against `background` and dropped.
    pub fn flatten(&self, background: [u8; 3]) -> Self {
        if !self.has_alpha() {
            return self.clone();
        }
        let mut out = self.clone();
        out.channels -= 1;
        for pixel in out.data.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            for (c, value) in pixel.iter_mut().take(3).enumerate() {
                *value = ((u32::from(*value) * alpha + u32::from(background[c]) * (255 - alpha) + 127) / 255) as u8;
            }
            pixel[3] = 255;
        }
        out
    }

    /// `rotate()` with no angle: the EXIF orientation is applied and cleared.
    pub fn auto_orient(&self) -> Self {
        if !(2..=8).contains(&self.orientation) {
            return self.clone();
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let (ow, oh) = if self.orientation >= 5 { (h, w) } else { (w, h) };
        let mut data = Vec::with_capacity(self.data.len());
        for y in 0..oh {
            for x in 0..ow {
                let (sx, sy) = match self.orientation {
                    2 => (w - 1 - x, y),
                    3 => (w - 1 - x, h - 1 - y),
                    4 => (x, h - 1 - y),
                    5 => (y, x),
                    6 => (y, h - 1 - x),
                    7 => (w - 1 - y, h - 1 - x),
                    _ => (w - 1 - y, x),
                };
                let at = (sy * w + sx) * 4;
                data.extend_from_slice(&self.data[at..at + 4]);
            }
        }
        Self { width: ow as u32, height: oh as u32, channels: self.channels, format: self.format, density: self.density, orientation: 1, data }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_bands_round_trip() {
        for channels in 1..=4u8 {
            let bytes: Vec<u8> = (0..2 * 3 * u32::from(channels)).map(|v| (v * 7) as u8).collect();
            let image = Image::from_raw(2, 3, channels, &bytes).unwrap();
            assert_eq!(image.to_raw(), bytes, "{channels}");
            assert_eq!(image.has_alpha(), channels == 2 || channels == 4);
        }
    }

    #[test]
    fn raw_input_of_the_wrong_size_is_refused() {
        assert!(Image::from_raw(2, 2, 3, &[0; 11]).is_err());
        assert!(Image::from_raw(2, 2, 5, &[0; 20]).is_err());
    }

    #[test]
    fn png_round_trips_every_band_layout_as_srgb() {
        for channels in 1..=4u8 {
            let bytes: Vec<u8> = (0..5 * 4 * u32::from(channels)).map(|v| (v * 13) as u8).collect();
            let image = Image::from_raw(5, 4, channels, &bytes).unwrap();
            let again = Image::decode(&image.to_png().unwrap()).unwrap();
            // Grey and grey with alpha come back as RGB and RGBA: sharp writes sRGB.
            let expected_channels = if image.has_alpha() { 4 } else { 3 };
            assert_eq!((again.width(), again.height(), again.channels()), (5, 4, expected_channels));
            assert_eq!(again.rgba(), image.rgba(), "{channels}");
        }
    }

    #[test]
    fn a_grey_png_is_one_band_and_a_file_without_resolution_reads_72() {
        // Grey 1x1 PNG written by hand: colour type 0.
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
        png.extend_from_slice(&[0; 4]);
        assert_eq!(png_facts(&png), (Some(1), Some(72)));
    }

    #[test]
    fn flatten_blends_against_the_background_and_drops_alpha() {
        let image = Image::from_raw(2, 1, 4, &[255, 0, 0, 255, 0, 0, 0, 0]).unwrap();
        let flat = image.flatten([255, 255, 255]);
        assert_eq!(flat.channels(), 3);
        assert_eq!(flat.to_raw(), vec![255, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn ensure_and_remove_alpha_change_the_band_count() {
        let image = Image::from_raw(1, 1, 3, &[1, 2, 3]).unwrap();
        assert_eq!(image.ensure_alpha().to_raw(), vec![1, 2, 3, 255]);
        assert_eq!(image.ensure_alpha().remove_alpha().to_raw(), vec![1, 2, 3]);
    }

    #[test]
    fn orientation_six_turns_the_picture_a_quarter_clockwise() {
        // 2x1: left red, right blue. Turned 90 degrees clockwise it is 1x2 with red on top.
        let mut image = Image::from_raw(2, 1, 3, &[255, 0, 0, 0, 0, 255]).unwrap();
        image.orientation = 6;
        let turned = image.auto_orient();
        assert_eq!((turned.width(), turned.height()), (1, 2));
        assert_eq!(turned.to_raw(), vec![255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn png_header_facts() {
        // Grey and alpha, 1x1, with a pHYs of 2835 pixels per metre (72 dpi).
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0]);
        png.extend_from_slice(&[0; 4]);
        png.extend_from_slice(&9u32.to_be_bytes());
        png.extend_from_slice(b"pHYs");
        png.extend_from_slice(&2835u32.to_be_bytes());
        png.extend_from_slice(&2835u32.to_be_bytes());
        png.push(1);
        png.extend_from_slice(&[0; 4]);
        assert_eq!(png_facts(&png), (Some(2), Some(72)));
        // 1000 pixels per metre is one per millimetre: libvips's own "nothing stated".
        let at = png.len() - 13;
        png[at..at + 4].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(png_facts(&png).1, None);
    }
}
