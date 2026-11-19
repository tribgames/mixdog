//! Still renditions of the media store: `renditions.mjs`'s `renditionSpec` and `encodeStill`, and the lossy WebP
//! encoder `encode.rs` calls for a resized WebP input (sharp's default WebP quality is 80).
//!
//! A rendition is the picture rotated upright by its EXIF orientation (a phone photo would otherwise land sideways in
//! the grid), fitted inside a square of the variant's edge without enlargement, and written as lossy WebP at the
//! variant's quality, the alpha kept when there is one. A source that does not decode has no rendition: Node's
//! `encodeStill` answers `null` and does not tell a missing decoder from a bad source either.

#[path = "webp.rs"]
mod webp;

use crate::decode::DEFAULT_PIXEL_LIMIT;
use crate::decode::Raster;
use crate::decode::decode;
use crate::resize::fit_inside_view;

pub(crate) use webp::encode_lossy as encode_webp;

/// One variant of a rendition (`SPECS` of `renditions.mjs`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StillSpec {
    /// The long edge in pixels.
    pub max_edge: u32,
    /// The WebP quality.
    pub quality: u8,
}

/// The gallery tile.
pub const THUMB: StillSpec = StillSpec { max_edge: 512, quality: 70 };

/// What a detail view shows.
pub const DISPLAY: StillSpec = StillSpec { max_edge: 2048, quality: 82 };

/// `renditionSpec`: the spec of a variant name, or `None` when the caller asked for the original.
pub fn rendition_spec(variant: &str) -> Option<StillSpec> {
    match variant {
        "thumb" => Some(THUMB),
        "display" => Some(DISPLAY),
        _ => None,
    }
}

/// `encodeStill`'s answer: the extension of the file (`.webp`) and its bytes.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Still {
    pub extension: &'static str,
    pub data: Vec<u8>,
}

/// Turns `raster` upright for an EXIF `orientation` (1 to 8; anything else leaves it as it is): what sharp's `rotate()`
/// with no argument does.
pub(crate) fn orient(raster: Raster, orientation: u8) -> Raster {
    if !(2..=8).contains(&orientation) {
        return raster;
    }
    let (width, height, channels) = (raster.width as usize, raster.height as usize, raster.channels());
    let swaps = orientation >= 5;
    let (out_width, out_height) = if swaps { (height, width) } else { (width, height) };
    let mut data = vec![0u8; raster.data.len()];
    for out_y in 0..out_height {
        for out_x in 0..out_width {
            let (x, y) = match orientation {
                2 => (width - 1 - out_x, out_y),
                3 => (width - 1 - out_x, height - 1 - out_y),
                4 => (out_x, height - 1 - out_y),
                5 => (out_y, out_x),
                6 => (out_y, height - 1 - out_x),
                7 => (width - 1 - out_y, height - 1 - out_x),
                _ => (width - 1 - out_y, out_x),
            };
            let from = (y * width + x) * channels;
            let to = (out_y * out_width + out_x) * channels;
            data[to..to + channels].copy_from_slice(&raster.data[from..from + channels]);
        }
    }
    Raster { width: out_width as u32, height: out_height as u32, has_alpha: raster.has_alpha, data }
}

/// `encodeStill`: the lossy WebP rendition of the image in `bytes` for `spec`, or `None` when the bytes do not
/// decode (or cannot be written).
pub fn encode_still(bytes: &[u8], spec: StillSpec) -> Option<Still> {
    let decoded = decode(bytes, DEFAULT_PIXEL_LIMIT).ok()?;
    let upright = orient(decoded.raster, decoded.orientation);
    let fitted = fit_inside_view(&upright, spec.max_edge, spec.max_edge, true);
    let data = webp::encode_lossy(&fitted, spec.quality).ok()?;
    Some(Still { extension: ".webp", data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DECODE_PIXEL_LIMIT;
    use crate::decode::Format;
    use crate::encode::encode_in_format;

    /// A picture whose pixel (x, y) is `[x, y, 0]`: where every pixel went shows in the result.
    fn coordinates(width: u32, height: u32) -> Raster {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[x as u8, y as u8, 0]);
            }
        }
        Raster { width, height, has_alpha: false, data }
    }

    fn pixel(raster: &Raster, x: u32, y: u32) -> [u8; 3] {
        let at = (y * raster.width + x) as usize * 3;
        [raster.data[at], raster.data[at + 1], raster.data[at + 2]]
    }

    #[test]
    fn the_variants_are_the_media_stores() {
        assert_eq!(rendition_spec("thumb"), Some(StillSpec { max_edge: 512, quality: 70 }));
        assert_eq!(rendition_spec("display"), Some(StillSpec { max_edge: 2048, quality: 82 }));
        assert_eq!(rendition_spec(""), None);
        assert_eq!(rendition_spec("original"), None);
    }

    #[test]
    fn every_orientation_turns_the_corners_where_exif_says() {
        // The 3x2 picture: (0,0) is the top left, (2,0) the top right.
        let source = coordinates(3, 2);
        // (orientation, output size, where the source's top-left pixel lands, where its top-right pixel lands)
        let expected: [(u8, (u32, u32), (u32, u32), (u32, u32)); 8] = [
            (1, (3, 2), (0, 0), (2, 0)),
            (2, (3, 2), (2, 0), (0, 0)),
            (3, (3, 2), (2, 1), (0, 1)),
            (4, (3, 2), (0, 1), (2, 1)),
            (5, (2, 3), (0, 0), (0, 2)),
            (6, (2, 3), (1, 0), (1, 2)),
            (7, (2, 3), (1, 2), (1, 0)),
            (8, (2, 3), (0, 2), (0, 0)),
        ];
        for (orientation, (width, height), top_left, top_right) in expected {
            let upright = orient(source.clone(), orientation);
            assert_eq!((upright.width, upright.height), (width, height), "orientation {orientation}");
            assert_eq!(pixel(&upright, top_left.0, top_left.1), [0, 0, 0], "orientation {orientation}: top left");
            assert_eq!(pixel(&upright, top_right.0, top_right.1), [2, 0, 0], "orientation {orientation}: top right");
        }
    }

    #[test]
    fn an_orientation_outside_one_to_eight_leaves_the_picture() {
        let source = coordinates(4, 3);
        assert_eq!(orient(source.clone(), 0), source);
        assert_eq!(orient(source.clone(), 9), source);
    }

    #[test]
    fn rotation_keeps_the_alpha_channel() {
        let source = Raster { width: 2, height: 1, has_alpha: true, data: vec![1, 2, 3, 4, 5, 6, 7, 8] };
        let turned = orient(source, 6);
        assert_eq!((turned.width, turned.height, turned.data), (1, 2, vec![1, 2, 3, 4, 5, 6, 7, 8]));
    }

    #[test]
    fn a_big_picture_is_fitted_inside_the_edge_and_never_enlarged() {
        let wide = encode_in_format(&coordinates(200, 100), Format::Png).unwrap();
        let still = encode_still(&wide, StillSpec { max_edge: 50, quality: 70 }).unwrap();
        assert_eq!(still.extension, ".webp");
        let back = decode(&still.data, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.format, back.width, back.height), (Format::Webp, 50, 25));
        let small = encode_still(&wide, THUMB).unwrap();
        let back = decode(&small.data, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!((back.width, back.height), (200, 100));
    }

    #[test]
    fn a_picture_with_alpha_keeps_it() {
        let raster = Raster { width: 8, height: 8, has_alpha: true, data: [200, 100, 50, 128].repeat(64) };
        let png = encode_in_format(&raster, Format::Png).unwrap();
        let still = encode_still(&png, THUMB).unwrap();
        assert!(decode(&still.data, DECODE_PIXEL_LIMIT).unwrap().raster.has_alpha);
    }

    #[test]
    fn bytes_that_do_not_decode_have_no_rendition() {
        assert_eq!(encode_still(b"", THUMB), None);
        assert_eq!(encode_still(b"definitely not an image", THUMB), None);
        let png = encode_in_format(&coordinates(30, 30), Format::Png).unwrap();
        assert_eq!(encode_still(&png[..png.len() / 2], THUMB), None);
    }
}
