//! `composite([...])`: overlays blended onto a base the way libvips does it, in premultiplied alpha, with the blend
//! modes the office code uses.
//!
//! Every overlay is laid on a base-sized transparent canvas first, so a mode that acts where the overlay is absent
//! does so here too (`dest-in` clears the base outside the overlay). The base gets an alpha band when it has none,
//! and the result keeps it, as sharp's does.

use crate::image::Image;

/// The blend modes of the office code.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Blend {
    #[default]
    Over,
    /// The base is kept where the overlay is opaque: its alpha is multiplied by the overlay's.
    DestIn,
    Multiply,
}

impl Blend {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "over" => Self::Over,
            "dest-in" => Self::DestIn,
            "multiply" => Self::Multiply,
            _ => return None,
        })
    }
}

/// Where an overlay goes: at pixel offsets, or in the middle (sharp's default gravity).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Placement {
    #[default]
    Centre,
    At { left: i64, top: i64 },
}

/// One entry of the `composite` list.
#[derive(Clone, Debug)]
pub struct Overlay {
    pub image: Image,
    pub blend: Blend,
    pub placement: Placement,
}

/// Straight RGBA bytes to premultiplied floats in 0 to 1.
fn premultiplied(pixel: &[u8], has_alpha: bool) -> [f32; 4] {
    let a = if has_alpha { f32::from(pixel[3]) / 255.0 } else { 1.0 };
    [f32::from(pixel[0]) / 255.0 * a, f32::from(pixel[1]) / 255.0 * a, f32::from(pixel[2]) / 255.0 * a, a]
}

/// The base with every overlay blended on in order.
pub fn composite(base: &Image, overlays: &[Overlay]) -> Image {
    let (width, height) = (base.width() as usize, base.height() as usize);
    let mut canvas: Vec<f32> = Vec::with_capacity(width * height * 4);
    for pixel in base.rgba().chunks_exact(4) {
        canvas.extend_from_slice(&premultiplied(pixel, base.has_alpha()));
    }
    for overlay in overlays {
        let image = &overlay.image;
        let (ow, oh) = (i64::from(image.width()), i64::from(image.height()));
        let (left, top) = match overlay.placement {
            Placement::At { left, top } => (left, top),
            Placement::Centre => ((width as i64 - ow) / 2, (height as i64 - oh) / 2),
        };
        for y in 0..height {
            for x in 0..width {
                let (ox, oy) = (x as i64 - left, y as i64 - top);
                let above = if (0..ow).contains(&ox) && (0..oh).contains(&oy) {
                    let at = (oy * ow + ox) as usize * 4;
                    premultiplied(&image.rgba()[at..at + 4], image.has_alpha())
                } else {
                    [0.0; 4]
                };
                let at = (y * width + x) * 4;
                let below = [canvas[at], canvas[at + 1], canvas[at + 2], canvas[at + 3]];
                for c in 0..4 {
                    let (o, b) = (above[c], below[c]);
                    canvas[at + c] = match overlay.blend {
                        Blend::Over => o + b * (1.0 - above[3]),
                        Blend::DestIn => b * above[3],
                        Blend::Multiply => o * (1.0 - below[3]) + b * (1.0 - above[3]) + o * b,
                    };
                }
            }
        }
    }
    let mut data = Vec::with_capacity(canvas.len());
    for pixel in canvas.chunks_exact(4) {
        let a = pixel[3];
        if a > 0.0 {
            let byte = |v: f32| ((v / a) * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            data.extend_from_slice(&[byte(pixel[0]), byte(pixel[1]), byte(pixel[2]), (a * 255.0 + 0.5).clamp(0.0, 255.0) as u8]);
        } else {
            data.extend_from_slice(&[0, 0, 0, 0]);
        }
    }
    Image::from_rgba(base.width(), base.height(), if base.has_alpha() { base.channels() } else { base.channels() + 1 }, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Image {
        Image::create(width, height, 4, rgba).unwrap()
    }

    fn overlay(image: Image, blend: Blend, placement: Placement) -> Overlay {
        Overlay { image, blend, placement }
    }

    #[test]
    fn over_puts_an_opaque_overlay_where_it_sits() {
        let base = solid(4, 2, [0, 0, 255, 255]);
        let out = composite(&base, &[overlay(solid(2, 1, [255, 0, 0, 255]), Blend::Over, Placement::At { left: 1, top: 1 })]);
        assert_eq!(&out.rgba()[(4 + 1) * 4..][..8], &[255, 0, 0, 255, 255, 0, 0, 255]);
        assert_eq!(&out.rgba()[..4], &[0, 0, 255, 255]);
        assert_eq!(&out.rgba()[(4 + 3) * 4..][..4], &[0, 0, 255, 255]);
    }

    #[test]
    fn a_half_transparent_overlay_mixes() {
        let base = solid(1, 1, [0, 0, 0, 255]);
        let out = composite(&base, &[overlay(solid(1, 1, [255, 255, 255, 128]), Blend::Over, Placement::Centre)]);
        assert!(out.rgba()[0].abs_diff(128) <= 1, "{:?}", out.rgba());
        assert_eq!(out.rgba()[3], 255);
    }

    #[test]
    fn dest_in_keeps_the_base_where_the_mask_is_opaque() {
        let base = solid(2, 1, [10, 20, 30, 255]);
        let mask = Image::from_raw(2, 1, 4, &[0, 0, 0, 255, 0, 0, 0, 0]).unwrap();
        let out = composite(&base, &[overlay(mask, Blend::DestIn, Placement::At { left: 0, top: 0 })]);
        assert_eq!(out.rgba(), &[10, 20, 30, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn dest_in_clears_the_base_outside_a_smaller_mask() {
        let base = solid(2, 1, [10, 20, 30, 255]);
        let out = composite(&base, &[overlay(solid(1, 1, [0, 0, 0, 255]), Blend::DestIn, Placement::At { left: 0, top: 0 })]);
        assert_eq!(out.rgba(), &[10, 20, 30, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn multiply_darkens() {
        let base = solid(1, 1, [200, 100, 50, 255]);
        let out = composite(&base, &[overlay(solid(1, 1, [128, 128, 128, 255]), Blend::Multiply, Placement::Centre)]);
        assert!(out.rgba()[0].abs_diff(100) <= 1 && out.rgba()[1].abs_diff(50) <= 1, "{:?}", out.rgba());
    }

    #[test]
    fn a_base_without_alpha_gains_it() {
        let base = Image::create(1, 1, 3, [1, 2, 3, 255]).unwrap();
        let out = composite(&base, &[]);
        assert_eq!(out.channels(), 4);
        assert_eq!(out.rgba(), &[1, 2, 3, 255]);
    }
}
