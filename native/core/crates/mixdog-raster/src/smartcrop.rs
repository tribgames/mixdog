//! libvips's smart crops, which sharp runs for `position: 'entropy'` and `position: 'attention'` after a `cover` resize.
//!
//! Entropy trims the image toward the crop size in up to eight steps per axis, each time removing the edge strip
//! whose histogram entropy is lower. Attention shrinks the image to 32 x 32, scores every sample by edges (a
//! Laplacian of luminance), skin tone and colourfulness, blurs the score map and centres the crop on its maximum.

use crate::image::Image;
use crate::ops::Kernel;
use crate::ops::Position;
use crate::ops::resize_exact;
use crate::ops::to_xyz;
use crate::ops::xyz_to_lab;

/// The side the attention score map is computed at.
const ATTENTION_SIDE: u32 = 32;

/// The skin tone libvips measures the colour distance to (a unit RGB vector).
const SKIN: [f64; 3] = [0.78, 0.57, 0.44];

/// Samples at or below this luminance (Y, white is 100) do not count as skin or colour.
const DARK: f64 = 5.0;

/// The top-left corner of the `width` x `height` window `mode` (entropy or attention) picks in `image`.
pub fn position(image: &Image, width: u32, height: u32, mode: Position) -> (u32, u32) {
    if width >= image.width() && height >= image.height() {
        return (0, 0);
    }
    match mode {
        Position::Attention => attention(image, width, height),
        _ => entropy(image, width, height),
    }
}

/// The bands the histograms are counted over: alpha-premultiplied colour and alpha as the image has them.
fn bands(image: &Image) -> Vec<u8> {
    let alpha = image.has_alpha();
    let mut out = Vec::with_capacity(image.rgba().len());
    for pixel in image.rgba().chunks_exact(4) {
        let k = if alpha { u32::from(pixel[3]) } else { 255 };
        let premultiplied = |v: u8| ((u32::from(v) * k + 127) / 255) as u8;
        match image.channels() {
            1 => out.push(premultiplied(pixel[0])),
            2 => out.extend_from_slice(&[premultiplied(pixel[0]), pixel[3]]),
            3 => out.extend_from_slice(&[pixel[0], pixel[1], pixel[2]]),
            _ => out.extend_from_slice(&[premultiplied(pixel[0]), premultiplied(pixel[1]), premultiplied(pixel[2]), pixel[3]]),
        }
    }
    out
}

/// The entropy of the pooled histogram of every band of a window.
fn entropy_of(bytes: &[u8], stride: usize, bands: usize, left: usize, top: usize, width: usize, height: usize) -> f64 {
    let mut histogram = [0u64; 256];
    for y in top..top + height {
        let row = &bytes[y * stride + left * bands..y * stride + (left + width) * bands];
        for &value in row {
            histogram[usize::from(value)] += 1;
        }
    }
    let total = (width * height * bands) as f64;
    histogram.iter().filter(|&&count| count > 0).map(|&count| {
        let p = count as f64 / total;
        -p * p.log2()
    }).sum()
}

fn entropy(image: &Image, width: u32, height: u32) -> (u32, u32) {
    let pixels = bands(image);
    let channels = usize::from(image.channels());
    let stride = image.width() as usize * channels;
    let (target_w, target_h) = (width as usize, height as usize);
    let (mut left, mut top) = (0usize, 0usize);
    let (mut cur_w, mut cur_h) = (image.width() as usize, image.height() as usize);
    let steps = |excess: usize| (excess as f64 / 8.0).ceil() as usize;
    let max_slice = steps(cur_w.saturating_sub(target_w)).max(steps(cur_h.saturating_sub(target_h))).max(1);
    while cur_w > target_w {
        let slice = max_slice.min(cur_w - target_w);
        let first = entropy_of(&pixels, stride, channels, left, top, slice, cur_h);
        let last = entropy_of(&pixels, stride, channels, left + cur_w - slice, top, slice, cur_h);
        if first < last {
            left += slice;
        }
        cur_w -= slice;
    }
    while cur_h > target_h {
        let slice = max_slice.min(cur_h - target_h);
        let first = entropy_of(&pixels, stride, channels, left, top, cur_w, slice);
        let last = entropy_of(&pixels, stride, channels, left, top + cur_h - slice, cur_w, slice);
        if first < last {
            top += slice;
        }
        cur_h -= slice;
    }
    (left as u32, top as u32)
}

/// A Gaussian blur of a square map, the mask cut where the curve falls under a fifth of its peak (libvips's default
/// `min_ampl`), the edges replicated.
fn blur(map: &[f64], side: usize, sigma: f64) -> Vec<f64> {
    let radius = (sigma * (2.0 * 5f64.ln()).sqrt()).ceil().max(1.0) as i64;
    let kernel: Vec<f64> = (-radius..=radius).map(|i| (-((i * i) as f64) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f64 = kernel.iter().sum();
    let at = |v: i64| v.clamp(0, side as i64 - 1) as usize;
    let mut across = vec![0.0; map.len()];
    for y in 0..side {
        for x in 0..side {
            across[y * side + x] = kernel.iter().enumerate().map(|(k, w)| w * map[y * side + at(x as i64 + k as i64 - radius)]).sum::<f64>() / sum;
        }
    }
    let mut out = vec![0.0; map.len()];
    for y in 0..side {
        for x in 0..side {
            out[y * side + x] = kernel.iter().enumerate().map(|(k, w)| w * across[at(y as i64 + k as i64 - radius) * side + x]).sum::<f64>() / sum;
        }
    }
    out
}

fn attention(image: &Image, width: u32, height: u32) -> (u32, u32) {
    let small = resize_exact(image, ATTENTION_SIDE, ATTENTION_SIDE, Kernel::Lanczos3);
    let side = ATTENTION_SIDE as usize;
    let (hscale, vscale) = (f64::from(ATTENTION_SIDE) / f64::from(image.width()), f64::from(ATTENTION_SIDE) / f64::from(image.height()));
    let mut luminance = vec![0.0; side * side];
    let mut skin = vec![0.0; side * side];
    let mut colour = vec![0.0; side * side];
    for (i, pixel) in small.rgba().chunks_exact(4).enumerate() {
        let k = if small.has_alpha() { f64::from(pixel[3]) / 255.0 } else { 1.0 };
        let [r, g, b] = [pixel[0], pixel[1], pixel[2]].map(|v| (f64::from(v) * k).round() as u8);
        let xyz = to_xyz(r, g, b);
        luminance[i] = xyz[1];
        if xyz[1] > DARK {
            let length = (f64::from(r).powi(2) + f64::from(g).powi(2) + f64::from(b).powi(2)).sqrt();
            if length > 0.0 {
                let unit = [f64::from(r) / length, f64::from(g) / length, f64::from(b) / length];
                let distance = ((unit[0] - SKIN[0]).powi(2) + (unit[1] - SKIN[1]).powi(2) + (unit[2] - SKIN[2]).powi(2)).sqrt();
                skin[i] = 100.0 - 100.0 * distance;
            }
            let lab = xyz_to_lab(xyz);
            colour[i] = (lab[1] * lab[1] + lab[2] * lab[2]).sqrt();
        }
    }
    let at = |v: i64| v.clamp(0, side as i64 - 1) as usize;
    let mut score = vec![0.0; side * side];
    for y in 0..side as i64 {
        for x in 0..side as i64 {
            let centre = luminance[y as usize * side + x as usize];
            let around = luminance[at(y - 1) * side + at(x)] + luminance[at(y + 1) * side + at(x)] + luminance[at(y) * side + at(x - 1)] + luminance[at(y) * side + at(x + 1)];
            let edge = (5.0 * (4.0 * centre - around)).abs();
            let i = y as usize * side + x as usize;
            score[i] = edge + skin[i] + colour[i];
        }
    }
    let crop = ((f64::from(width) * hscale).powi(2) + (f64::from(height) * vscale).powi(2)).sqrt();
    let blurred = blur(&score, side, (crop / 10.0).max(1.0));
    let mut best = 0usize;
    for (i, &value) in blurred.iter().enumerate() {
        if value > blurred[best] {
            best = i;
        }
    }
    let (x, y) = ((best % side) as f64 / hscale, (best / side) as f64 / vscale);
    let clip = |centre: f64, window: u32, total: u32| ((centre - f64::from(window) / 2.0) as i64).clamp(0, i64::from(total.saturating_sub(window))) as u32;
    (clip(x, width, image.width()), clip(y, height, image.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat grey picture with a busy saturated square in one place.
    fn with_square(width: u32, height: u32, left: u32, top: u32, side: u32) -> Image {
        let mut bytes = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let inside = x >= left && x < left + side && y >= top && y < top + side;
                bytes.extend_from_slice(&if inside {
                    if (x + y) % 2 == 0 { [250, 20, 20] } else { [20, 20, 250] }
                } else {
                    [120, 120, 120]
                });
            }
        }
        Image::from_raw(width, height, 3, &bytes).unwrap()
    }

    #[test]
    fn entropy_keeps_the_busy_side() {
        let right = with_square(120, 40, 90, 5, 28);
        let (left, top) = position(&right, 40, 40, Position::Entropy);
        assert_eq!(top, 0);
        assert!(left >= 70, "{left}");
        let near = with_square(120, 40, 2, 5, 28);
        assert_eq!(position(&near, 40, 40, Position::Entropy), (0, 0));
    }

    #[test]
    fn attention_follows_the_colourful_detail() {
        let right = with_square(128, 64, 96, 16, 30);
        let (left, top) = position(&right, 32, 64, Position::Attention);
        assert_eq!(top, 0);
        assert!(left >= 80, "{left}");
        let near = with_square(128, 64, 2, 16, 30);
        assert!(position(&near, 32, 64, Position::Attention).0 <= 8);
    }

    #[test]
    fn a_window_as_big_as_the_picture_is_the_picture() {
        let image = with_square(20, 10, 0, 0, 5);
        assert_eq!(position(&image, 20, 10, Position::Attention), (0, 0));
    }
}
