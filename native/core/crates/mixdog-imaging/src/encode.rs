//! Encoding with sharp's defaults. A resized image keeps the format it came in: JPEG at quality 80, PNG at zlib level
//! 6 with no row filter and no palette (what sharp writes by default), GIF (one frame, 256 colours) and TIFF, WebP
//! through `still.rs` and AVIF (`heif`) through `avif.rs`.
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

/// The palette search's speed argument. It is never consulted: a picture is brought down to 256 colours by
/// [`quantize_to_palette`] before the encoder sees it, and the encoder writes a picture of at most 256 colours with
/// its exact palette.
const GIF_SPEED: i32 = 10;

/// A GIF palette has 256 entries.
const GIF_PALETTE_SIZE: usize = 256;

fn encoding_failure(error: &ImageError) -> ImagingError {
    ImagingError::environment(format!("the image could not be encoded: {error}"))
}

/// The RGB pixels of `raster` with its alpha flattened against the grey level `background` (0 is black, 255 white).
pub fn flatten(raster: &Raster, background: u8) -> Vec<u8> {
    flattened_rgb(raster, background).into_owned()
}

pub(crate) fn flattened_rgb(raster: &Raster, background: u8) -> std::borrow::Cow<'_, [u8]> {
    if !raster.has_alpha {
        return std::borrow::Cow::Borrowed(&raster.data);
    }
    let background = u32::from(background);
    let mut rgb = Vec::with_capacity(raster.data.len() / 4 * 3);
    for pixel in raster.data.as_chunks::<4>().0.iter() {
        let alpha = u32::from(pixel[3]);
        for &channel in &pixel[..3] {
            rgb.push(((u32::from(channel) * alpha + background * (255 - alpha) + 127) / 255) as u8);
        }
    }
    std::borrow::Cow::Owned(rgb)
}

/// A baseline 4:2:0 JPEG at `quality`, the alpha flattened against `background`.
pub fn encode_jpeg(raster: &Raster, quality: u8, background: u8) -> Vec<u8> {
    jpeg_enc::encode_rgb(raster.width, raster.height, &flattened_rgb(raster, background), quality)
}

fn encode_png(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let mut out = Vec::new();
    let color = if raster.has_alpha { ExtendedColorType::Rgba8 } else { ExtendedColorType::Rgb8 };
    PngEncoder::new_with_quality(&mut out, CompressionType::Level(PNG_COMPRESSION_LEVEL), FilterType::NoFilter)
        .write_image(&raster.data, raster.width, raster.height, color)
        .map_err(|error| encoding_failure(&error))?;
    Ok(out)
}

/// The colours of one median-cut box, each with the count of pixels that carry it.
type ColourBox = Vec<(u32, u64)>;

/// Brings the opaque pixels of `rgba` down to the colours of a palette that leaves room for a transparent entry when
/// there is a transparent pixel (the encoder reads alpha 0 as the transparent colour and every other alpha as opaque).
/// A picture with colours to spare is untouched. The palette is median cut over the colours the picture has, each
/// weighed by how many pixels carry it, and every colour is then moved to the nearest palette entry.
fn quantize_to_palette(rgba: &mut [u8]) {
    // Every transparent pixel is one colour: the encoder counts the colour under alpha 0 as an entry of its own.
    for pixel in rgba.as_chunks_mut::<4>().0.iter_mut().filter(|pixel| pixel[3] == 0) {
        pixel[..3].fill(0);
    }
    let transparent = rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] == 0);
    let budget = GIF_PALETTE_SIZE - usize::from(transparent);
    let mut keys: Vec<u32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|pixel| pixel[3] != 0)
        .map(|pixel| u32::from(pixel[0]) << 16 | u32::from(pixel[1]) << 8 | u32::from(pixel[2]))
        .collect();
    keys.sort_unstable();
    let mut colours: Vec<(u32, u64)> = Vec::new();
    for key in keys {
        match colours.last_mut() {
            Some((last, count)) if *last == key => *count += 1,
            _ => colours.push((key, 1)),
        }
    }
    if colours.len() <= budget {
        return;
    }
    let palette = median_cut_palette(&colours, budget);
    let nearest = |key: u32| -> [u8; 3] {
        let (r, g, b) = (i32::from(channel(key, 16)), i32::from(channel(key, 8)), i32::from(channel(key, 0)));
        let best = palette.iter().min_by_key(|entry| (entry[0] - r).pow(2) + (entry[1] - g).pow(2) + (entry[2] - b).pow(2)).copied().unwrap_or([0; 3]);
        [best[0] as u8, best[1] as u8, best[2] as u8]
    };
    let mapped: std::collections::HashMap<u32, [u8; 3]> = colours.iter().map(|&(key, _)| (key, nearest(key))).collect();
    for pixel in rgba.as_chunks_mut::<4>().0.iter_mut().filter(|pixel| pixel[3] != 0) {
        let key = u32::from(pixel[0]) << 16 | u32::from(pixel[1]) << 8 | u32::from(pixel[2]);
        pixel[..3].copy_from_slice(&mapped[&key]);
    }
}

fn channel(key: u32, shift: u32) -> u8 {
    ((key >> shift) & 0xFF) as u8
}

/// `budget` palette entries, the mean colour of each box of a median cut over `colours` (colour, pixel count) that
/// always splits the box with the widest channel range at the pixel-count median.
fn median_cut_palette(colours: &[(u32, u64)], budget: usize) -> Vec<[i32; 3]> {
    let range_of = |boxed: &[(u32, u64)]| -> (u8, u32) {
        let mut best = (0u8, 0u32);
        for shift in [16u32, 8, 0] {
            let low = boxed.iter().map(|&(key, _)| channel(key, shift)).min().unwrap_or(0);
            let high = boxed.iter().map(|&(key, _)| channel(key, shift)).max().unwrap_or(0);
            if u32::from(high - low) > u32::from(best.0) {
                best = (high - low, shift);
            }
        }
        best
    };
    // Each box carries its widest channel range, worked out once when the box is made.
    let mut boxes: Vec<(ColourBox, (u8, u32))> = vec![(colours.to_vec(), range_of(colours))];
    while boxes.len() < budget {
        let split =
            boxes.iter().enumerate().filter(|(_, (boxed, _))| boxed.len() > 1).map(|(at, &(_, range))| (at, range)).max_by_key(|&(_, (range, _))| range);
        let Some((at, (_, shift))) = split else { break };
        let (mut boxed, _) = boxes.swap_remove(at);
        boxed.sort_unstable_by_key(|&(key, _)| channel(key, shift));
        let total: u64 = boxed.iter().map(|&(_, count)| count).sum();
        let mut seen = 0;
        let mut cut = 1;
        for (index, &(_, count)) in boxed.iter().enumerate() {
            seen += count;
            if seen * 2 >= total {
                cut = (index + 1).clamp(1, boxed.len() - 1);
                break;
            }
        }
        let upper = boxed.split_off(cut);
        let (lower_range, upper_range) = (range_of(&boxed), range_of(&upper));
        boxes.push((boxed, lower_range));
        boxes.push((upper, upper_range));
    }
    boxes
        .iter()
        .map(|(boxed, _)| {
            let total: u64 = boxed.iter().map(|&(_, count)| count).sum();
            let mean = |shift: u32| ((boxed.iter().map(|&(key, count)| u64::from(channel(key, shift)) * count).sum::<u64>() + total / 2) / total) as i32;
            [mean(16), mean(8), mean(0)]
        })
        .collect()
}

fn encode_gif(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let mut out = Vec::new();
    {
        let mut rgba = raster.to_rgba();
        quantize_to_palette(&mut rgba);
        let mut encoder = GifEncoder::new_with_speed(&mut out, GIF_SPEED);
        encoder.encode(&rgba, raster.width, raster.height, ExtendedColorType::Rgba8).map_err(|error| encoding_failure(&error))?;
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
        // An SVG is written as the PNG of its raster.
        Format::Png | Format::Svg => encode_png(raster),
        Format::Avif => crate::avif::encode_avif(raster),
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
    fn a_picture_of_few_colours_keeps_them_and_one_of_many_is_cut_to_a_palette() {
        let mut few = gradient(8, 8, false).to_rgba();
        let before = few.clone();
        quantize_to_palette(&mut few);
        assert_eq!(few, before);
        let mut many = gradient(64, 64, true).to_rgba();
        for (n, pixel) in many.chunks_exact_mut(4).enumerate() {
            pixel[3] = if n % 7 == 0 { 0 } else { 255 };
        }
        quantize_to_palette(&mut many);
        let colours: std::collections::HashSet<[u8; 4]> = many.chunks_exact(4).map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]]).collect();
        assert!(colours.len() <= 256, "{} colours", colours.len());
        assert!(colours.contains(&[0, 0, 0, 0]));
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
