//! Encoding with sharp's defaults. A resized image keeps the format it came in: JPEG at quality 80, PNG at zlib level
//! 6 with no row filter and no palette (what sharp writes by default), GIF (one frame, 256 colours) and TIFF, and WebP
//! through `still.rs`.
//!
//! JPEG has no alpha: libvips flattens it against black, which is what [`flatten`] does with the default
//! background (a tool-result image names white).

use std::io::Cursor;

use image::ExtendedColorType;
use image::ImageEncoder;
use image::ImageError;
use image::codecs::gif::GifEncoder;
use image::codecs::png::CompressionType;
use image::codecs::png::FilterType;
use image::codecs::png::PngEncoder;
use image::codecs::tiff::TiffEncoder;

use crate::decode::Format;
use crate::decode::Raster;
use crate::error::ImagingError;
use crate::jpeg_enc;
use crate::still;

/// sharp's default JPEG quality.
pub const DEFAULT_JPEG_QUALITY: u8 = 80;

/// sharp's default WebP quality.
pub const DEFAULT_WEBP_QUALITY: u8 = 80;

/// sharp's default PNG compression level.
const PNG_COMPRESSION_LEVEL: u8 = 6;

/// The speed of the GIF palette search (the `gif` crate's own default): 1 is best and slowest, 30 fastest.
const GIF_SPEED: i32 = 10;

fn encoding_failure(error: &ImageError) -> ImagingError {
    ImagingError::environment(format!("the image could not be encoded: {error}"))
}

/// The RGB pixels of `raster` with its alpha flattened against the grey level `background` (0 is black, 255 white).
pub fn flatten(raster: &Raster, background: u8) -> Vec<u8> {
    if !raster.has_alpha {
        return raster.data.clone();
    }
    let background = u32::from(background);
    let mut rgb = Vec::with_capacity(raster.data.len() / 4 * 3);
    for pixel in raster.data.chunks_exact(4) {
        let alpha = u32::from(pixel[3]);
        for &channel in &pixel[..3] {
            rgb.push(((u32::from(channel) * alpha + background * (255 - alpha) + 127) / 255) as u8);
        }
    }
    rgb
}

/// A baseline 4:2:0 JPEG at `quality`, the alpha flattened against `background`.
pub fn encode_jpeg(raster: &Raster, quality: u8, background: u8) -> Vec<u8> {
    jpeg_enc::encode_rgb(raster.width, raster.height, &flatten(raster, background), quality)
}

fn encode_png(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let mut out = Vec::new();
    let color = if raster.has_alpha { ExtendedColorType::Rgba8 } else { ExtendedColorType::Rgb8 };
    PngEncoder::new_with_quality(&mut out, CompressionType::Level(PNG_COMPRESSION_LEVEL), FilterType::NoFilter)
        .write_image(&raster.data, raster.width, raster.height, color)
        .map_err(|error| encoding_failure(&error))?;
    Ok(out)
}

fn encode_gif(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new_with_speed(&mut out, GIF_SPEED);
        encoder.encode(&raster.to_rgba(), raster.width, raster.height, ExtendedColorType::Rgba8).map_err(|error| encoding_failure(&error))?;
    }
    Ok(out)
}

fn encode_tiff(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let mut out = Cursor::new(Vec::new());
    let color = if raster.has_alpha { ExtendedColorType::Rgba8 } else { ExtendedColorType::Rgb8 };
    TiffEncoder::new(&mut out).encode(&raster.data, raster.width, raster.height, color).map_err(|error| encoding_failure(&error))?;
    Ok(out.into_inner())
}

/// `sharp(buffer).resize(...).toBuffer()`: the pixels written in the format the input had, with sharp's defaults.
pub fn encode_in_format(raster: &Raster, format: Format) -> Result<Vec<u8>, ImagingError> {
    match format {
        Format::Jpeg => Ok(encode_jpeg(raster, DEFAULT_JPEG_QUALITY, 0)),
        Format::Png => encode_png(raster),
        Format::Gif => encode_gif(raster),
        Format::Tiff => encode_tiff(raster),
        Format::Webp => still::encode_webp(raster, DEFAULT_WEBP_QUALITY),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DECODE_PIXEL_LIMIT;
    use crate::decode::decode;

    fn gradient(width: u32, height: u32, has_alpha: bool) -> Raster {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[(x * 255 / width.max(1)) as u8, (y * 255 / height.max(1)) as u8, 100]);
                if has_alpha {
                    data.push(if x % 2 == 0 { 255 } else { 128 });
                }
            }
        }
        Raster { width, height, has_alpha, data }
    }

    #[test]
    fn flattening_an_opaque_pixel_keeps_it_and_a_transparent_one_takes_the_background() {
        let raster = Raster { width: 3, height: 1, has_alpha: true, data: vec![200, 100, 50, 255, 200, 100, 50, 0, 200, 100, 50, 128] };
        assert_eq!(flatten(&raster, 0), [200, 100, 50, 0, 0, 0, 100, 50, 25]);
        assert_eq!(flatten(&raster, 255), [200, 100, 50, 255, 255, 255, 227, 177, 152]);
        let opaque = gradient(2, 2, false);
        assert_eq!(flatten(&opaque, 0), opaque.data);
    }

    #[test]
    fn png_keeps_every_pixel_and_the_alpha() {
        for has_alpha in [false, true] {
            let raster = gradient(17, 9, has_alpha);
            let png = encode_in_format(&raster, Format::Png).unwrap();
            let back = decode(&png, DECODE_PIXEL_LIMIT).unwrap();
            assert_eq!((back.format, back.width, back.height), (Format::Png, 17, 9));
            assert_eq!(back.raster, raster, "alpha {has_alpha}");
        }
    }

    #[test]
    fn tiff_keeps_every_pixel() {
        let raster = gradient(11, 7, false);
        let tiff = encode_in_format(&raster, Format::Tiff).unwrap();
        let back = decode(&tiff, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.format, back.raster), (Format::Tiff, raster));
    }

    #[test]
    fn gif_has_the_size_and_close_colours() {
        let raster = gradient(32, 16, false);
        let gif = encode_in_format(&raster, Format::Gif).unwrap();
        let back = decode(&gif, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.format, back.width, back.height), (Format::Gif, 32, 16));
        let rgba = raster.to_rgba();
        let worst = back.raster.to_rgba().iter().zip(&rgba).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
        assert!(worst <= 40, "the palette is off by {worst}");
    }

    #[test]
    fn jpeg_round_trips_within_quantisation() {
        let raster = gradient(40, 24, false);
        let jpeg = encode_in_format(&raster, Format::Jpeg).unwrap();
        let back = decode(&jpeg, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.format, back.width, back.height, back.raster.has_alpha), (Format::Jpeg, 40, 24, false));
        let total: u64 = back.raster.data.iter().zip(&raster.data).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
        assert!(total as f64 / raster.data.len() as f64 <= 4.0, "mean error {}", total as f64 / raster.data.len() as f64);
    }

    #[test]
    fn webp_is_written_lossy_with_the_alpha_it_had() {
        for has_alpha in [false, true] {
            let raster = gradient(32, 24, has_alpha);
            let webp = encode_in_format(&raster, Format::Webp).unwrap();
            let back = decode(&webp, DECODE_PIXEL_LIMIT).unwrap();
            assert_eq!((back.format, back.width, back.height, back.raster.has_alpha), (Format::Webp, 32, 24, has_alpha));
        }
    }
}
