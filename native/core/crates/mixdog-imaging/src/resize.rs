//! Fit-inside resizing, as sharp does it with its default kernel: Lanczos3, a separable filter whose support grows
//! with the shrink factor (so a large reduction averages the area it covers), applied to premultiplied colour when
//! there is an alpha channel. The output size is libvips's rule: one scale for both axes (the larger of the two
//! ratios, so the picture fits inside the box), each side the rounded quotient, and never an enlargement when the
//! caller says so and the picture already fits.
//!
//! An axis that grows is not resampled with Lanczos3: libvips enlarges through the interpolator it infers from the
//! kernel, bicubic (Catmull-Rom) for Lanczos3, whose four taps ring far less at a hard edge than Lanczos3's six (which
//! is what keeps a flat-coloured picture small once it is written as a JPEG).

use crate::decode::Raster;

/// The size `resize(box_width, box_height, { fit: 'inside', withoutEnlargement })` gives a `width` x `height` image.
pub fn output_size(width: u32, height: u32, box_width: u32, box_height: u32, without_enlargement: bool) -> (u32, u32) {
    let (w, h) = (f64::from(width), f64::from(height));
    let mut shrink = (w / f64::from(box_width)).max(h / f64::from(box_height));
    if without_enlargement && width <= box_width && height <= box_height {
        shrink = 1.0;
    }
    let side = |length: f64| ((length / shrink).round() as u32).max(1);
    (side(w), side(h))
}

/// The Lanczos kernel of three lobes.
fn lanczos3(x: f64) -> f64 {
    let x = x.abs();
    if x < 1e-9 {
        return 1.0;
    }
    if x >= 3.0 {
        return 0.0;
    }
    let pix = std::f64::consts::PI * x;
    3.0 * pix.sin() * (pix / 3.0).sin() / (pix * pix)
}

/// The cubic of Catmull and Rom (the bicubic of libvips: Keys with a of minus one half).
fn catmull_rom(x: f64) -> f64 {
    let x = x.abs();
    if x < 1.0 {
        1.0 + x * x * (1.5 * x - 2.5)
    } else if x < 2.0 {
        2.0 + x * (-4.0 + x * (2.5 - 0.5 * x))
    } else {
        0.0
    }
}

/// For each output sample, the input samples it reads and their normalised weights; an index past an edge is the edge
/// sample.
struct Taps {
    offsets: Vec<usize>,
    entries: Vec<(u32, f32)>,
}

impl Taps {
    fn new(in_len: u32, out_len: u32) -> Self {
        let scale = f64::from(in_len) / f64::from(out_len);
        let last = i64::from(in_len) - 1;
        let mut offsets = Vec::with_capacity(out_len as usize + 1);
        let mut entries = Vec::new();
        offsets.push(0);
        if scale < 1.0 {
            for out in 0..out_len {
                let center = (f64::from(out) + 0.5) * scale - 0.5;
                let base = center.floor();
                for k in (base as i64 - 1)..=(base as i64 + 2) {
                    entries.push((k.clamp(0, last) as u32, catmull_rom(k as f64 - center) as f32));
                }
                offsets.push(entries.len());
            }
            return Self { offsets, entries };
        }
        let filter_scale = scale.max(1.0);
        let support = 3.0 * filter_scale;
        for out in 0..out_len {
            let center = (f64::from(out) + 0.5) * scale - 0.5;
            let first = (center - support).ceil() as i64;
            let end = (center + support).floor() as i64;
            let start = entries.len();
            let mut sum = 0.0;
            for k in first..=end {
                let weight = lanczos3((k as f64 - center) / filter_scale);
                entries.push((k.clamp(0, last) as u32, weight as f32));
                sum += weight;
            }
            let sum = sum as f32;
            for entry in &mut entries[start..] {
                entry.1 /= sum;
            }
            offsets.push(entries.len());
        }
        Self { offsets, entries }
    }

    fn of(&self, out: usize) -> &[(u32, f32)] {
        &self.entries[self.offsets[out]..self.offsets[out + 1]]
    }
}

/// Resamples the x axis: `h` rows of `w_in` pixels become rows of `out_w` pixels. `load` reads pixel `index` into
/// `px` (as many values as `channels`).
fn pass_x(load: impl Fn(usize, &mut [f32; 4]), w_in: usize, h: usize, out_w: usize, channels: usize, taps: &Taps) -> Vec<f32> {
    let mut out = vec![0f32; out_w * h * channels];
    let mut px = [0f32; 4];
    for y in 0..h {
        for ox in 0..out_w {
            let mut acc = [0f32; 4];
            for &(ix, weight) in taps.of(ox) {
                load(y * w_in + ix as usize, &mut px);
                for c in 0..channels {
                    acc[c] += weight * px[c];
                }
            }
            let at = (y * out_w + ox) * channels;
            out[at..at + channels].copy_from_slice(&acc[..channels]);
        }
    }
    out
}

/// Resamples the y axis: `w` columns of `h_in` pixels become columns of `out_h` pixels.
fn pass_y(load: impl Fn(usize, &mut [f32; 4]), w: usize, out_h: usize, channels: usize, taps: &Taps) -> Vec<f32> {
    let mut out = vec![0f32; w * out_h * channels];
    let mut px = [0f32; 4];
    for oy in 0..out_h {
        let row = &mut out[oy * w * channels..(oy + 1) * w * channels];
        for &(iy, weight) in taps.of(oy) {
            for x in 0..w {
                load(iy as usize * w + x, &mut px);
                for c in 0..channels {
                    row[x * channels + c] += weight * px[c];
                }
            }
        }
    }
    out
}

/// A loader over the floats an earlier pass left.
fn from_floats(buffer: &[f32], channels: usize) -> impl Fn(usize, &mut [f32; 4]) + '_ {
    move |index, px| {
        let at = index * channels;
        px[..channels].copy_from_slice(&buffer[at..at + channels]);
    }
}

/// Fits `raster` inside `box_width` x `box_height` keeping the aspect ratio. A result of the size the picture already
/// has is the picture itself.
pub fn fit_inside(raster: &Raster, box_width: u32, box_height: u32, without_enlargement: bool) -> Raster {
    let (out_w, out_h) = output_size(raster.width, raster.height, box_width, box_height, without_enlargement);
    if (out_w, out_h) == (raster.width, raster.height) {
        return raster.clone();
    }
    let channels = raster.channels();
    let premultiply = raster.has_alpha;
    let source = |index: usize, px: &mut [f32; 4]| {
        let at = index * channels;
        if premultiply {
            let alpha = f32::from(raster.data[at + 3]) / 255.0;
            for (c, slot) in px.iter_mut().take(3).enumerate() {
                *slot = f32::from(raster.data[at + c]) * alpha;
            }
            px[3] = f32::from(raster.data[at + 3]);
        } else {
            for (c, slot) in px.iter_mut().take(channels).enumerate() {
                *slot = f32::from(raster.data[at + c]);
            }
        }
    };
    let (w_in, h_in) = (raster.width as usize, raster.height as usize);
    let taps_x = Taps::new(raster.width, out_w);
    let taps_y = Taps::new(raster.height, out_h);
    // Whichever axis shrinks the working buffer more goes first.
    let floats = if out_w as usize * h_in <= w_in * out_h as usize {
        let wide = pass_x(source, w_in, h_in, out_w as usize, channels, &taps_x);
        pass_y(from_floats(&wide, channels), out_w as usize, out_h as usize, channels, &taps_y)
    } else {
        let tall = pass_y(source, w_in, out_h as usize, channels, &taps_y);
        pass_x(from_floats(&tall, channels), w_in, out_h as usize, out_w as usize, channels, &taps_x)
    };
    Raster { width: out_w, height: out_h, has_alpha: raster.has_alpha, data: quantize(&floats, channels, premultiply) }
}

fn to_byte(value: f32) -> u8 {
    (value + 0.5).clamp(0.0, 255.0) as u8
}

/// Floats to bytes, unpremultiplying colour where there is an alpha channel.
fn quantize(floats: &[f32], channels: usize, premultiplied: bool) -> Vec<u8> {
    if !premultiplied {
        return floats.iter().map(|&value| to_byte(value)).collect();
    }
    let mut bytes = Vec::with_capacity(floats.len());
    for pixel in floats.chunks_exact(channels) {
        let alpha = pixel[3];
        if alpha > 0.0 {
            let gain = 255.0 / alpha;
            bytes.extend([to_byte(pixel[0] * gain), to_byte(pixel[1] * gain), to_byte(pixel[2] * gain), to_byte(alpha)]);
        } else {
            bytes.extend([0, 0, 0, 0]);
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(width: u32, height: u32, rgba: Option<[u8; 4]>, rgb: [u8; 3]) -> Raster {
        let mut data = Vec::new();
        for _ in 0..width * height {
            data.extend_from_slice(&rgb);
            if let Some(rgba) = rgba {
                data.push(rgba[3]);
            }
        }
        Raster { width, height, has_alpha: rgba.is_some(), data }
    }

    #[test]
    fn the_output_size_is_one_scale_for_both_axes_rounded() {
        assert_eq!(output_size(1920, 1080, 1456, 831, true), (1456, 819));
        assert_eq!(output_size(100, 500, 200, 300, true), (60, 300));
        assert_eq!(output_size(4000, 100, 1568, 39, true), (1560, 39));
        assert_eq!(output_size(1, 1, 200, 200, false), (200, 200));
        assert_eq!(output_size(1, 1000, 2, 1568, false), (2, 1568));
    }

    #[test]
    fn without_enlargement_a_picture_inside_the_box_keeps_its_size() {
        assert_eq!(output_size(100, 50, 400, 400, true), (100, 50));
        assert_eq!(output_size(100, 50, 400, 400, false), (400, 200));
        // One side over the box shrinks the whole picture.
        assert_eq!(output_size(500, 50, 400, 400, true), (400, 40));
    }

    #[test]
    fn a_size_that_does_not_change_is_the_picture_itself() {
        let raster = flat(7, 5, None, [1, 2, 3]);
        assert_eq!(fit_inside(&raster, 7, 5, true), raster);
        assert_eq!(fit_inside(&raster, 70, 50, true), raster);
    }

    #[test]
    fn a_flat_picture_stays_flat_at_any_size() {
        let raster = flat(37, 23, None, [200, 100, 50]);
        for (w, h) in [(10, 6), (74, 46), (37, 5), (1, 1)] {
            let out = fit_inside(&raster, w, h, false);
            assert!(out.data.chunks_exact(3).all(|p| p == [200, 100, 50]), "{w}x{h}");
        }
    }

    #[test]
    fn halving_a_checkerboard_gives_its_mean() {
        let mut data = Vec::new();
        for y in 0..16u32 {
            for x in 0..16u32 {
                let v = if (x + y) % 2 == 0 { 0 } else { 255 };
                data.extend_from_slice(&[v, v, v]);
            }
        }
        let out = fit_inside(&Raster { width: 16, height: 16, has_alpha: false, data }, 8, 8, true);
        assert_eq!((out.width, out.height), (8, 8));
        // Away from the edges, where the filter reads replicated samples.
        for y in 3..5usize {
            for x in 3..5usize {
                let at = (y * 8 + x) * 3;
                assert!((120..=135).contains(&out.data[at]), "{x},{y}: {:?}", &out.data[at..at + 3]);
            }
        }
    }

    #[test]
    fn a_gradient_keeps_its_ends_and_order() {
        let mut data = Vec::new();
        for _y in 0..4 {
            for x in 0..64u32 {
                let v = (x * 4) as u8;
                data.extend_from_slice(&[v, v, v]);
            }
        }
        let out = fit_inside(&Raster { width: 64, height: 4, has_alpha: false, data }, 16, 1, true);
        assert_eq!((out.width, out.height), (16, 1));
        let reds: Vec<u8> = out.data.chunks_exact(3).map(|p| p[0]).collect();
        assert!(reds.windows(2).all(|pair| pair[1] + 3 >= pair[0]), "{reds:?}");
        assert!(reds[0] < 30 && reds[15] > 225, "{reds:?}");
    }

    #[test]
    fn colour_is_averaged_with_its_alpha_so_a_transparent_pixel_adds_none() {
        // Left half opaque red, right half fully transparent: the single output pixel is half-transparent red.
        let mut data = Vec::new();
        for x in 0..2 {
            data.extend_from_slice(if x == 0 { &[255, 0, 0, 255] } else { &[0, 255, 0, 0] });
        }
        let out = fit_inside(&Raster { width: 2, height: 1, has_alpha: true, data }, 1, 1, true);
        assert_eq!((out.width, out.height, out.has_alpha), (1, 1, true));
        assert!((120..=135).contains(&out.data[3]), "{:?}", out.data);
        assert!(out.data[0] >= 250 && out.data[1] <= 5, "{:?}", out.data);
    }

    #[test]
    fn enlarging_a_flat_pixel_fills_the_box() {
        let out = fit_inside(&flat(1, 1, Some([0, 0, 0, 255]), [10, 20, 30]), 200, 200, false);
        assert_eq!((out.width, out.height), (200, 200));
        assert!(out.data.chunks_exact(4).all(|p| p == [10, 20, 30, 255]));
    }
}
