//! Colour management: libvips converts an image that carries an ICC profile to sRGB before it does anything else
//! (perceptual intent, 8 bit), and an image with CMYK inks to RGB through its profile. moxcms does the same here.
//!
//! A profile that cannot be read, or that does not describe the colour space of the pixels, leaves the pixels as they
//! are: libvips catches the failed transform and goes on with the untouched image.

use moxcms::ColorProfile;
use moxcms::DataColorSpace;
use moxcms::Layout;
use moxcms::Transform8BitExecutor;
use moxcms::TransformOptions;

/// Pixels converted per call, so the working copy of a very large image stays small (a multiple of 3 and of 4).
const CHUNK_PIXELS: usize = 1 << 16;

/// Converts 8-bit RGB (3 bytes a pixel) or RGBA (4 bytes, alpha kept) pixels from the colour space of `icc` to sRGB,
/// in place. Anything but an RGB-space profile is left alone.
pub fn rgb_to_srgb(data: &mut [u8], has_alpha: bool, icc: &[u8]) {
    let Ok(profile) = ColorProfile::new_from_slice(icc) else { return };
    if profile.color_space != DataColorSpace::Rgb {
        return;
    }
    let layout = if has_alpha { Layout::Rgba } else { Layout::Rgb };
    let Ok(transform) = profile.create_transform_8bit(layout, &ColorProfile::new_srgb(), layout, TransformOptions::default()) else {
        return;
    };
    let stride = if has_alpha { 4 } else { 3 };
    for chunk in data.chunks_mut(CHUNK_PIXELS * stride) {
        let source = chunk.to_vec();
        if moxcms::TransformExecutor::transform(transform.as_ref(), &source, chunk).is_err() {
            // A failed transform is skipped like libvips skips it: the chunk keeps its colours (a transform that
            // wrote a part leaves the part, which is no worse than the profile's own range).
            chunk.copy_from_slice(&source);
        }
    }
}

/// The CMYK-to-sRGB transform of a CMYK profile.
pub(crate) struct CmykConverter {
    transform: Box<Transform8BitExecutor>,
    /// What black point compensation does to one sRGB channel value (see [`black_point_curve`]).
    compensation: [u8; 256],
}

impl CmykConverter {
    /// `None` when `icc` is not a readable CMYK profile.
    pub(crate) fn new(icc: &[u8]) -> Option<Self> {
        let profile = ColorProfile::new_from_slice(icc).ok()?;
        if profile.color_space != DataColorSpace::Cmyk {
            return None;
        }
        // Eight-bit CMYK shares the layout of eight-bit RGBA.
        let transform = profile.create_transform_8bit(Layout::Rgba, &ColorProfile::new_srgb(), Layout::Rgb, TransformOptions::default()).ok()?;
        let compensation = black_point_curve(black_luminance(&profile).unwrap_or(0.0));
        Some(Self { transform, compensation })
    }

    /// `cmyk` is 4 bytes a pixel; an Adobe file stores the inks inverted (255 is no ink), which `inverted` undoes as
    /// libvips does. The answer is 3 bytes a pixel.
    pub(crate) fn convert(&self, cmyk: &[u8], inverted: bool) -> Option<Vec<u8>> {
        let mut rgb = vec![0u8; cmyk.len() / 4 * 3];
        for (source, target) in cmyk.chunks(CHUNK_PIXELS * 4).zip(rgb.chunks_mut(CHUNK_PIXELS * 3)) {
            let inks: Vec<u8> = if inverted { source.iter().map(|ink| 255 - ink).collect() } else { source.to_vec() };
            moxcms::TransformExecutor::transform(self.transform.as_ref(), &inks, target).ok()?;
            for value in target.iter_mut() {
                *value = self.compensation[usize::from(*value)];
            }
        }
        Some(rgb)
    }
}

/// The luminance (Y, white being 1) of the darkest colorant of a CMYK profile: every ink at its full strength, read
/// through the profile and kept neutral and no lighter than L* 50, as lcms2 detects a black point.
fn black_luminance(profile: &ColorProfile) -> Option<f64> {
    // ProPhoto RGB is a D50 space with a plain 1.8 power curve, so its linear luminance is a fixed mix of the three.
    let transform = profile.create_transform_f32(Layout::Rgba, &ColorProfile::new_pro_photo_rgb(), Layout::Rgb, TransformOptions::default()).ok()?;
    let mut black = [0f32; 3];
    moxcms::TransformExecutor::transform(transform.as_ref(), &[1.0, 1.0, 1.0, 1.0], &mut black).ok()?;
    let linear = |value: f32| f64::from(value).max(0.0).powf(1.8);
    let luminance = 0.288_040_2 * linear(black[0]) + 0.711_874_1 * linear(black[1]) + 0.000_085_7 * linear(black[2]);
    // L* 50 is a luminance of 0.1842.
    Some(luminance.clamp(0.0, 0.184_187_5))
}

/// Black point compensation for an sRGB destination whose own black is 0: libvips asks lcms to map the profile's black
/// onto the destination's, which in linear light takes `y` off every channel and rescales what is left. As each
/// channel moves alone, the whole conversion is one table over the 256 channel values.
fn black_point_curve(y: f64) -> [u8; 256] {
    let mut curve = [0u8; 256];
    for (value, slot) in curve.iter_mut().enumerate() {
        let encoded = value as f64 / 255.0;
        let linear = if encoded <= 0.04045 { encoded / 12.92 } else { ((encoded + 0.055) / 1.055).powf(2.4) };
        let compensated = ((linear - y) / (1.0 - y)).max(0.0);
        let back = if compensated <= 0.003_130_8 { compensated * 12.92 } else { 1.055 * compensated.powf(1.0 / 2.4) - 0.055 };
        *slot = (back * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
    }
    curve
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_that_cannot_be_read_leaves_the_pixels() {
        let mut pixels = vec![10, 20, 30, 40, 50, 60];
        rgb_to_srgb(&mut pixels, false, b"not an icc profile");
        assert_eq!(pixels, [10, 20, 30, 40, 50, 60]);
        assert!(CmykConverter::new(b"not an icc profile").is_none());
    }

    #[test]
    fn the_srgb_profile_maps_an_srgb_pixel_to_itself_within_a_step() {
        let srgb = ColorProfile::new_srgb().encode().expect("sRGB encodes");
        let mut pixels = vec![200, 100, 50, 255, 0, 128, 0, 0, 0, 255, 255, 255];
        let original = pixels.clone();
        rgb_to_srgb(&mut pixels, false, &srgb);
        for (got, want) in pixels.iter().zip(&original) {
            assert!(got.abs_diff(*want) <= 2, "{pixels:?} vs {original:?}");
        }
    }

    #[test]
    fn alpha_survives_a_conversion() {
        let srgb = ColorProfile::new_srgb().encode().expect("sRGB encodes");
        let mut pixels = vec![200, 100, 50, 77, 10, 20, 30, 255];
        rgb_to_srgb(&mut pixels, true, &srgb);
        assert_eq!([pixels[3], pixels[7]], [77, 255]);
    }

    #[test]
    fn an_rgb_profile_is_not_a_cmyk_profile() {
        let srgb = ColorProfile::new_srgb().encode().expect("sRGB encodes");
        assert!(CmykConverter::new(&srgb).is_none());
    }

    #[test]
    fn black_point_compensation_keeps_white_and_takes_the_black_to_zero() {
        let none = black_point_curve(0.0);
        assert!((0..=255).all(|value| none[value].abs_diff(value as u8) <= 1));
        let curve = black_point_curve(0.0159);
        assert_eq!((curve[0], curve[255]), (0, 255));
        assert_eq!(curve[30], 0, "a value at the black's own luminance is black");
        assert!(curve[128] < 128 && curve[128] > 120);
    }
}
