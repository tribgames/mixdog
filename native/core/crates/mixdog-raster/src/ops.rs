//! The geometry and colour operations: resize (every fit, gravity and kernel), extract, extend, greyscale, linear,
//! modulate and trim, as sharp runs them.
//!
//! Resampling is separable, in premultiplied floats when the image has alpha, with a support that grows with the
//! shrink factor, like `mixdog-imaging`'s fit-inside (which is the Lanczos3 case of the same rule: the output size of
//! `inside` is that module's [`output_size`]). `mixdog-imaging`'s resampler keeps its taps private and only fits a
//! box, so the independent per-axis sizes `fill` and `cover` need, and the kernels other than Lanczos3, live here.

use std::sync::OnceLock;

use mixdog_imaging::resize::output_size;

use crate::RasterError;
use crate::image::Image;
use crate::smartcrop;

/// sharp's `kernel` option; the default is Lanczos3.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Mitchell,
    Lanczos2,
    #[default]
    Lanczos3,
}

impl Kernel {
    /// The names sharp accepts.
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "nearest" => Self::Nearest,
            "linear" => Self::Linear,
            "cubic" => Self::Cubic,
            "mitchell" => Self::Mitchell,
            "lanczos2" => Self::Lanczos2,
            "lanczos3" => Self::Lanczos3,
            _ => return None,
        })
    }

    fn support(self) -> f64 {
        match self {
            Self::Nearest | Self::Linear => 1.0,
            Self::Cubic | Self::Mitchell | Self::Lanczos2 => 2.0,
            Self::Lanczos3 => 3.0,
        }
    }

    fn weight(self, x: f64) -> f64 {
        let x = x.abs();
        match self {
            Self::Nearest => 1.0,
            Self::Linear => (1.0 - x).max(0.0),
            Self::Cubic => cubic(x, 0.0, 0.5),
            Self::Mitchell => cubic(x, 1.0 / 3.0, 1.0 / 3.0),
            Self::Lanczos2 => lanczos(x, 2.0),
            Self::Lanczos3 => lanczos(x, 3.0),
        }
    }
}

/// The Mitchell-Netravali family: B = 0, C = 1/2 is Catmull-Rom, B = C = 1/3 is Mitchell.
fn cubic(x: f64, b: f64, c: f64) -> f64 {
    if x < 1.0 {
        ((12.0 - 9.0 * b - 6.0 * c) * x * x * x + (-18.0 + 12.0 * b + 6.0 * c) * x * x + (6.0 - 2.0 * b)) / 6.0
    } else if x < 2.0 {
        ((-b - 6.0 * c) * x * x * x + (6.0 * b + 30.0 * c) * x * x + (-12.0 * b - 48.0 * c) * x + (8.0 * b + 24.0 * c)) / 6.0
    } else {
        0.0
    }
}

fn lanczos(x: f64, lobes: f64) -> f64 {
    if x < 1e-9 {
        return 1.0;
    }
    if x >= lobes {
        return 0.0;
    }
    let pix = std::f64::consts::PI * x;
    lobes * pix.sin() * (pix / lobes).sin() / (pix * pix)
}

/// sharp's `fit`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Fit {
    #[default]
    Cover,
    Contain,
    Fill,
    Inside,
    Outside,
}

impl Fit {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "cover" => Self::Cover,
            "contain" => Self::Contain,
            "fill" => Self::Fill,
            "inside" => Self::Inside,
            "outside" => Self::Outside,
            _ => return None,
        })
    }
}

/// sharp's `position` (gravity) and the two smart crops.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Position {
    #[default]
    Centre,
    North,
    NorthEast,
    East,
    SouthEast,
    South,
    SouthWest,
    West,
    NorthWest,
    Entropy,
    Attention,
}

impl Position {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "centre" | "center" => Self::Centre,
            "north" | "top" => Self::North,
            "northeast" | "right top" => Self::NorthEast,
            "east" | "right" => Self::East,
            "southeast" | "right bottom" => Self::SouthEast,
            "south" | "bottom" => Self::South,
            "southwest" | "left bottom" => Self::SouthWest,
            "west" | "left" => Self::West,
            "northwest" | "left top" => Self::NorthWest,
            "entropy" => Self::Entropy,
            "attention" => Self::Attention,
            _ => return None,
        })
    }

    /// Where the gravity sits on each axis: -1 at the start, 0 in the middle, 1 at the end.
    fn axes(self) -> (i8, i8) {
        match self {
            Self::North => (0, -1),
            Self::NorthEast => (1, -1),
            Self::East => (1, 0),
            Self::SouthEast => (1, 1),
            Self::South => (0, 1),
            Self::SouthWest => (-1, 1),
            Self::West => (-1, 0),
            Self::NorthWest => (-1, -1),
            Self::Centre | Self::Entropy | Self::Attention => (0, 0),
        }
    }
}

/// `resize(width, height, { fit, position, kernel, background })`.
#[derive(Clone, Debug)]
pub struct ResizeOptions {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fit: Fit,
    pub position: Position,
    pub kernel: Kernel,
    /// The canvas colour of `contain` (RGBA); sharp's default is opaque black.
    pub background: [u8; 4],
}

impl Default for ResizeOptions {
    fn default() -> Self {
        Self { width: None, height: None, fit: Fit::Cover, position: Position::Centre, kernel: Kernel::Lanczos3, background: [0, 0, 0, 255] }
    }
}

/// For each output sample, the input samples it reads and their normalised weights; an index past an edge is the edge
/// sample.
struct Taps {
    offsets: Vec<usize>,
    entries: Vec<(u32, f32)>,
}

impl Taps {
    fn new(in_len: u32, out_len: u32, kernel: Kernel) -> Self {
        let scale = f64::from(in_len) / f64::from(out_len);
        let last = i64::from(in_len) - 1;
        let mut offsets = Vec::with_capacity(out_len as usize + 1);
        let mut entries = Vec::new();
        offsets.push(0);
        for out in 0..out_len {
            if kernel == Kernel::Nearest {
                let at = (((f64::from(out) + 0.5) * scale).floor() as i64).clamp(0, last);
                entries.push((at as u32, 1.0));
                offsets.push(entries.len());
                continue;
            }
            let filter_scale = scale.max(1.0);
            let support = kernel.support() * filter_scale;
            let center = (f64::from(out) + 0.5) * scale - 0.5;
            let first = (center - support).ceil() as i64;
            let end = (center + support).floor() as i64;
            let start = entries.len();
            let mut sum = 0.0;
            for k in first..=end {
                let weight = kernel.weight((k as f64 - center) / filter_scale);
                entries.push((k.clamp(0, last) as u32, weight as f32));
                sum += weight;
            }
            if sum.abs() < 1e-12 {
                entries.truncate(start);
                entries.push(((center.round() as i64).clamp(0, last) as u32, 1.0));
            } else {
                let sum = sum as f32;
                for entry in &mut entries[start..] {
                    entry.1 /= sum;
                }
            }
            offsets.push(entries.len());
        }
        Self { offsets, entries }
    }

    fn of(&self, out: usize) -> &[(u32, f32)] {
        &self.entries[self.offsets[out]..self.offsets[out + 1]]
    }
}

/// Resamples the x axis of RGBA floats: `h` rows of `w_in` pixels become rows of `out_w` pixels.
fn pass_x(src: &[f32], w_in: usize, h: usize, out_w: usize, taps: &Taps) -> Vec<f32> {
    let mut out = vec![0f32; out_w * h * 4];
    for y in 0..h {
        let row = &src[y * w_in * 4..(y + 1) * w_in * 4];
        for ox in 0..out_w {
            let mut acc = [0f32; 4];
            for &(ix, weight) in taps.of(ox) {
                let at = ix as usize * 4;
                for c in 0..4 {
                    acc[c] += weight * row[at + c];
                }
            }
            let at = (y * out_w + ox) * 4;
            out[at..at + 4].copy_from_slice(&acc);
        }
    }
    out
}

/// Resamples the y axis: `w` columns of `h_in` pixels become columns of `out_h` pixels.
fn pass_y(src: &[f32], w: usize, out_h: usize, taps: &Taps) -> Vec<f32> {
    let stride = w * 4;
    let mut out = vec![0f32; stride * out_h];
    for oy in 0..out_h {
        let dst = &mut out[oy * stride..(oy + 1) * stride];
        for &(iy, weight) in taps.of(oy) {
            let row = &src[iy as usize * stride..(iy as usize + 1) * stride];
            for (d, s) in dst.iter_mut().zip(row) {
                *d += weight * s;
            }
        }
    }
    out
}

fn to_byte(value: f32) -> u8 {
    (value + 0.5).clamp(0.0, 255.0) as u8
}

/// The image resampled to exactly `width` x `height` (sharp's `fill`), colour premultiplied by alpha where there is one.
pub fn resize_exact(image: &Image, width: u32, height: u32, kernel: Kernel) -> Image {
    let (w_in, h_in) = (image.width() as usize, image.height() as usize);
    if (width, height) == (image.width(), image.height()) {
        return image.clone();
    }
    let alpha = image.has_alpha();
    let mut floats = Vec::with_capacity(image.rgba().len());
    for pixel in image.rgba().chunks_exact(4) {
        let a = f32::from(pixel[3]);
        let k = if alpha { a / 255.0 } else { 1.0 };
        floats.extend_from_slice(&[f32::from(pixel[0]) * k, f32::from(pixel[1]) * k, f32::from(pixel[2]) * k, a]);
    }
    let taps_x = Taps::new(image.width(), width, kernel);
    let taps_y = Taps::new(image.height(), height, kernel);
    let (out_w, out_h) = (width as usize, height as usize);
    // Whichever axis shrinks the working buffer more goes first.
    let resampled = if out_w * h_in <= w_in * out_h {
        let wide = pass_x(&floats, w_in, h_in, out_w, &taps_x);
        pass_y(&wide, out_w, out_h, &taps_y)
    } else {
        let tall = pass_y(&floats, w_in, out_h, &taps_y);
        pass_x(&tall, w_in, out_h, out_w, &taps_x)
    };
    let mut data = Vec::with_capacity(out_w * out_h * 4);
    for pixel in resampled.chunks_exact(4) {
        if alpha {
            if pixel[3] > 0.0 {
                let gain = 255.0 / pixel[3];
                data.extend_from_slice(&[to_byte(pixel[0] * gain), to_byte(pixel[1] * gain), to_byte(pixel[2] * gain), to_byte(pixel[3])]);
            } else {
                data.extend_from_slice(&[0, 0, 0, 0]);
            }
        } else {
            data.extend_from_slice(&[to_byte(pixel[0]), to_byte(pixel[1]), to_byte(pixel[2]), 255]);
        }
    }
    Image::from_rgba(width, height, image.channels(), data)
}

/// `resize(width, height, options)`: with one side only the other follows the aspect ratio.
pub fn resize(image: &Image, options: &ResizeOptions) -> Result<Image, RasterError> {
    let (iw, ih) = (image.width(), image.height());
    let (w, h) = match (options.width, options.height) {
        (None, None) => return Ok(image.clone()),
        (Some(w), None) => (w, ((f64::from(ih) * f64::from(w) / f64::from(iw)).round() as u32).max(1)),
        (None, Some(h)) => (((f64::from(iw) * f64::from(h) / f64::from(ih)).round() as u32).max(1), h),
        (Some(w), Some(h)) => (w, h),
    };
    if w == 0 || h == 0 {
        return Err(RasterError::new("Expected positive integer for width and height"));
    }
    let kernel = options.kernel;
    match options.fit {
        Fit::Fill => Ok(resize_exact(image, w, h, kernel)),
        Fit::Inside => {
            let (rw, rh) = output_size(iw, ih, w, h, false);
            Ok(resize_exact(image, rw, rh, kernel))
        }
        Fit::Contain => {
            let source = if options.background[3] < 255 { image.ensure_alpha() } else { image.clone() };
            let (rw, rh) = output_size(iw, ih, w, h, false);
            let resized = resize_exact(&source, rw, rh, kernel);
            Ok(embed(&resized, w, h, options.position, options.background))
        }
        Fit::Outside | Fit::Cover => {
            let (x_factor, y_factor) = (f64::from(iw) / f64::from(w), f64::from(ih) / f64::from(h));
            let factor = x_factor.min(y_factor);
            let mut rw = ((f64::from(iw) / factor).round() as u32).max(1);
            let mut rh = ((f64::from(ih) / factor).round() as u32).max(1);
            if x_factor < y_factor {
                rw = w;
            } else {
                rh = h;
            }
            let resized = resize_exact(image, rw, rh, kernel);
            if options.fit == Fit::Outside {
                return Ok(resized);
            }
            let (left, top) = match options.position {
                Position::Entropy | Position::Attention => smartcrop::position(&resized, w, h, options.position),
                gravity => {
                    let (gx, gy) = gravity.axes();
                    let at = |gravity: i8, diff: u32| match gravity {
                        -1 => 0,
                        0 => (diff + 1) / 2,
                        _ => diff,
                    };
                    (at(gx, rw - w), at(gy, rh - h))
                }
            };
            extract(&resized, left, top, w, h)
        }
    }
}

/// `extract({ left, top, width, height })`.
pub fn extract(image: &Image, left: u32, top: u32, width: u32, height: u32) -> Result<Image, RasterError> {
    let inside_w = u64::from(left) + u64::from(width) <= u64::from(image.width());
    let inside_h = u64::from(top) + u64::from(height) <= u64::from(image.height());
    if width == 0 || height == 0 || !inside_w || !inside_h {
        return Err(RasterError::new("extract_area: bad extract area"));
    }
    let stride = image.width() as usize * 4;
    let mut data = Vec::with_capacity(width as usize * height as usize * 4);
    for y in top..top + height {
        let at = y as usize * stride + left as usize * 4;
        data.extend_from_slice(&image.rgba()[at..at + width as usize * 4]);
    }
    Ok(Image::from_rgba(width, height, image.channels(), data))
}

/// The image set on a `width` x `height` canvas of `background` at the gravity (`contain`'s embed; the middle is the
/// floor of half the difference).
fn embed(image: &Image, width: u32, height: u32, position: Position, background: [u8; 4]) -> Image {
    let (gx, gy) = position.axes();
    let at = |gravity: i8, diff: u32| match gravity {
        -1 => 0,
        0 => diff / 2,
        _ => diff,
    };
    place(image, width, height, at(gx, width - image.width()), at(gy, height - image.height()), background)
}

/// The image at (`left`, `top`) on a canvas of `background`; the band layout is widened where the background needs it.
fn place(image: &Image, width: u32, height: u32, left: u32, top: u32, background: [u8; 4]) -> Image {
    let mut channels = image.channels();
    if background[3] < 255 && !image.has_alpha() {
        channels += 1;
    }
    if channels <= 2 && !(background[0] == background[1] && background[1] == background[2]) {
        channels += 2;
    }
    let mut data: Vec<u8> = background.iter().copied().cycle().take(width as usize * height as usize * 4).collect();
    let stride = width as usize * 4;
    let row = image.width() as usize * 4;
    for y in 0..image.height() as usize {
        let to = (top as usize + y) * stride + left as usize * 4;
        data[to..to + row].copy_from_slice(&image.rgba()[y * row..(y + 1) * row]);
    }
    Image::from_rgba(width, height, channels, data)
}

/// `extend({ top, bottom, left, right, background })`.
pub fn extend(image: &Image, top: u32, bottom: u32, left: u32, right: u32, background: [u8; 4]) -> Image {
    place(image, image.width() + left + right, image.height() + top + bottom, left, top, background)
}

fn srgb_lut() -> &'static [f64; 256] {
    static LUT: OnceLock<[f64; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut lut = [0.0; 256];
        for (value, slot) in lut.iter_mut().enumerate() {
            let c = value as f64 / 255.0;
            *slot = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
        }
        lut
    })
}

/// sRGB byte to linear light, 0 to 1.
pub(crate) fn to_linear(value: u8) -> f64 {
    srgb_lut()[usize::from(value)]
}

/// Linear light, 0 to 1, to the sRGB value 0 to 1.
pub(crate) fn from_linear(value: f64) -> f64 {
    let v = value.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

const WHITE: [f64; 3] = [95.047, 100.0, 108.883];

/// sRGB bytes to CIE XYZ (D65, Y of white = 100), libvips's matrix.
pub(crate) fn to_xyz(r: u8, g: u8, b: u8) -> [f64; 3] {
    let (r, g, b) = (to_linear(r), to_linear(g), to_linear(b));
    [
        100.0 * (0.4124 * r + 0.3576 * g + 0.1805 * b),
        100.0 * (0.2126 * r + 0.7152 * g + 0.0722 * b),
        100.0 * (0.0193 * r + 0.1192 * g + 0.9505 * b),
    ]
}

fn lab_f(t: f64) -> f64 {
    if t > 0.008_856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 }
}

fn lab_f_inverse(t: f64) -> f64 {
    let cube = t * t * t;
    if cube > 0.008_856 { cube } else { (t - 16.0 / 116.0) / 7.787 }
}

/// XYZ to CIE L*a*b* (D65).
pub(crate) fn xyz_to_lab(xyz: [f64; 3]) -> [f64; 3] {
    let (fx, fy, fz) = (lab_f(xyz[0] / WHITE[0]), lab_f(xyz[1] / WHITE[1]), lab_f(xyz[2] / WHITE[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn lab_to_srgb(lab: [f64; 3]) -> [u8; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let (fx, fz) = (fy + lab[1] / 500.0, fy - lab[2] / 200.0);
    let (x, y, z) = (lab_f_inverse(fx) * WHITE[0] / 100.0, lab_f_inverse(fy), lab_f_inverse(fz) * WHITE[2] / 100.0);
    let linear = [
        3.2406 * x - 1.5372 * y - 0.4986 * z,
        -0.9689 * x + 1.8758 * y + 0.0415 * z,
        0.0557 * x - 0.2040 * y + 1.0570 * z,
    ];
    [0, 1, 2].map(|c| to_byte((from_linear(linear[c]) * 255.0) as f32))
}

/// `greyscale()`: libvips's `b-w` conversion, the Rec. 709 luminance of the linear light written back as sRGB. One
/// band (two with alpha).
pub fn greyscale(image: &Image) -> Image {
    let mut data = Vec::with_capacity(image.rgba().len());
    for pixel in image.rgba().chunks_exact(4) {
        let y = 0.2126 * to_linear(pixel[0]) + 0.7152 * to_linear(pixel[1]) + 0.0722 * to_linear(pixel[2]);
        let grey = to_byte((from_linear(y) * 255.0) as f32);
        data.extend_from_slice(&[grey, grey, grey, pixel[3]]);
    }
    Image::from_rgba(image.width(), image.height(), if image.has_alpha() { 2 } else { 1 }, data)
}

/// `linear(a, b)` on the colour bands: `a * value + b`, rounded and clipped to 0..255; alpha is untouched.
pub fn linear(image: &Image, a: f64, b: f64) -> Image {
    let mut data = image.rgba().to_vec();
    for pixel in data.chunks_exact_mut(4) {
        for value in pixel.iter_mut().take(3) {
            *value = to_byte((a * f64::from(*value) + b) as f32);
        }
    }
    Image::from_rgba(image.width(), image.height(), image.channels(), data)
}

/// `modulate({ brightness, saturation, hue })`: lightness and chroma of the L*C*h colour are multiplied and the hue
/// angle (degrees) added. A grey image keeps its band count only when the result is still grey.
pub fn modulate(image: &Image, brightness: f64, saturation: f64, hue: f64) -> Image {
    let mut data = Vec::with_capacity(image.rgba().len());
    let angle = hue.to_radians();
    for pixel in image.rgba().chunks_exact(4) {
        let [l, a, b] = xyz_to_lab(to_xyz(pixel[0], pixel[1], pixel[2]));
        let chroma = (a * a + b * b).sqrt() * saturation;
        let h = b.atan2(a) + angle;
        let [r, g, bl] = lab_to_srgb([l * brightness, chroma * h.cos(), chroma * h.sin()]);
        data.extend_from_slice(&[r, g, bl, pixel[3]]);
    }
    let channels = match image.channels() {
        1 => 3,
        2 => 4,
        other => other,
    };
    Image::from_rgba(image.width(), image.height(), channels, data)
}

/// What `trim` found: the cropped image and its offset in the source (sharp reports it as `trimOffsetLeft` and `trimOffsetTop`, negated).
#[derive(Clone, Debug)]
pub struct Trimmed {
    pub image: Image,
    pub left: u32,
    pub top: u32,
}

/// `trim({ threshold })`: the box of pixels that differ from the top-left pixel by more than `threshold` in a band
/// (colour flattened against that pixel's colour first when there is alpha, as libvips's `find_trim` does). An image
/// with nothing different is returned whole.
pub fn trim(image: &Image, threshold: f64) -> Result<Trimmed, RasterError> {
    let first = &image.rgba()[..4];
    let background = [first[0], first[1], first[2]];
    let flat = image.flatten(background);
    let (w, h) = (image.width() as usize, image.height() as usize);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            let pixel = &flat.rgba()[(y * w + x) * 4..];
            let differs = (0..3).any(|c| (f64::from(pixel[c]) - f64::from(background[c])).abs() > threshold);
            if differs {
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
            }
        }
    }
    if min_x > max_x {
        return Ok(Trimmed { image: image.clone(), left: 0, top: 0 });
    }
    let cut = extract(image, min_x as u32, min_y as u32, (max_x - min_x + 1) as u32, (max_y - min_y + 1) as u32)?;
    Ok(Trimmed { image: cut, left: min_x as u32, top: min_y as u32 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(width: u32, height: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Image {
        let mut bytes = Vec::new();
        for y in 0..height {
            for x in 0..width {
                bytes.extend_from_slice(&f(x, y));
            }
        }
        Image::from_raw(width, height, 3, &bytes).unwrap()
    }

    fn options(width: u32, height: u32, fit: Fit) -> ResizeOptions {
        ResizeOptions { width: Some(width), height: Some(height), fit, ..ResizeOptions::default() }
    }

    #[test]
    fn every_fit_gives_the_size_sharp_gives() {
        let image = rgb(40, 20, |x, _| [x as u8, 0, 0]);
        for (fit, expected) in [(Fit::Fill, (10, 10)), (Fit::Cover, (10, 10)), (Fit::Contain, (10, 10)), (Fit::Inside, (10, 5)), (Fit::Outside, (20, 10))] {
            let out = resize(&image, &options(10, 10, fit)).unwrap();
            assert_eq!((out.width(), out.height()), expected, "{fit:?}");
        }
    }

    #[test]
    fn one_side_only_keeps_the_aspect_ratio() {
        let image = rgb(40, 20, |_, _| [9, 9, 9]);
        let out = resize(&image, &ResizeOptions { width: Some(10), ..ResizeOptions::default() }).unwrap();
        assert_eq!((out.width(), out.height()), (10, 5));
        let out = resize(&image, &ResizeOptions { height: Some(10), ..ResizeOptions::default() }).unwrap();
        assert_eq!((out.width(), out.height()), (20, 10));
    }

    #[test]
    fn contain_pads_with_the_background_and_adds_alpha_for_a_transparent_one() {
        let image = rgb(40, 20, |_, _| [200, 100, 50]);
        let out = resize(&image, &ResizeOptions { background: [0, 0, 0, 0], ..options(10, 10, Fit::Contain) }).unwrap();
        assert_eq!(out.channels(), 4);
        // 10x5 picture centred in 10x10: rows 0..2 are padding (floor of 5/2), rows 2..7 the picture.
        assert_eq!(&out.rgba()[..4], &[0, 0, 0, 0]);
        assert_eq!(&out.rgba()[(3 * 10 + 5) * 4..][..4], &[200, 100, 50, 255]);
        assert_eq!(&out.rgba()[(8 * 10 + 5) * 4..][..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn cover_crops_at_the_gravity() {
        // Left half red, right half blue.
        let image = rgb(40, 20, |x, _| if x < 20 { [255, 0, 0] } else { [0, 0, 255] });
        let west = resize(&image, &ResizeOptions { position: Position::West, ..options(10, 20, Fit::Cover) }).unwrap();
        assert_eq!(&west.rgba()[..3], &[255, 0, 0]);
        let east = resize(&image, &ResizeOptions { position: Position::East, ..options(10, 20, Fit::Cover) }).unwrap();
        assert_eq!(&east.rgba()[..3], &[0, 0, 255]);
    }

    #[test]
    fn kernels_keep_a_flat_picture_flat() {
        let image = rgb(13, 9, |_, _| [30, 60, 90]);
        for kernel in [Kernel::Nearest, Kernel::Linear, Kernel::Cubic, Kernel::Mitchell, Kernel::Lanczos2, Kernel::Lanczos3] {
            for (w, h) in [(5, 3), (26, 18)] {
                let out = resize_exact(&image, w, h, kernel);
                assert!(out.rgba().chunks_exact(4).all(|p| p[..3] == [30, 60, 90]), "{kernel:?} {w}x{h}");
            }
        }
    }

    #[test]
    fn nearest_picks_a_source_pixel() {
        let image = rgb(2, 1, |x, _| if x == 0 { [10, 0, 0] } else { [250, 0, 0] });
        let out = resize_exact(&image, 4, 1, Kernel::Nearest);
        let reds: Vec<u8> = out.rgba().chunks_exact(4).map(|p| p[0]).collect();
        assert_eq!(reds, vec![10, 10, 250, 250]);
    }

    #[test]
    fn extract_and_its_refusal() {
        let image = rgb(4, 4, |x, y| [(y * 4 + x) as u8, 0, 0]);
        let cut = extract(&image, 1, 2, 2, 2).unwrap();
        assert_eq!(cut.to_raw(), vec![9, 0, 0, 10, 0, 0, 13, 0, 0, 14, 0, 0]);
        assert_eq!(extract(&image, 3, 0, 2, 1).unwrap_err().message(), "extract_area: bad extract area");
    }

    #[test]
    fn extend_adds_a_border() {
        let image = rgb(1, 1, |_, _| [7, 7, 7]);
        let out = extend(&image, 1, 0, 2, 0, [1, 2, 3, 255]);
        assert_eq!((out.width(), out.height()), (3, 2));
        assert_eq!(out.to_raw(), vec![1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 7, 7, 7]);
    }

    #[test]
    fn greyscale_of_grey_is_itself_and_of_white_is_white() {
        let grey = greyscale(&rgb(2, 1, |x, _| if x == 0 { [255, 255, 255] } else { [0, 0, 0] }));
        assert_eq!((grey.channels(), grey.to_raw()), (1, vec![255, 0]));
        let mid = greyscale(&rgb(1, 1, |_, _| [128, 128, 128]));
        assert!(mid.to_raw()[0].abs_diff(128) <= 1);
    }

    #[test]
    fn linear_maps_and_clips() {
        let out = linear(&rgb(1, 1, |_, _| [100, 200, 0]), 2.0, -50.0);
        assert_eq!(out.to_raw(), vec![150, 255, 0]);
    }

    #[test]
    fn modulate_without_change_is_the_identity_and_zero_saturation_is_grey() {
        let image = rgb(1, 1, |_, _| [200, 80, 40]);
        let same = modulate(&image, 1.0, 1.0, 0.0).to_raw();
        assert!(same.iter().zip(image.to_raw()).all(|(a, b)| a.abs_diff(b) <= 2), "{same:?}");
        let grey = modulate(&image, 1.0, 0.0, 0.0).to_raw();
        assert!(grey[0].abs_diff(grey[1]) <= 1 && grey[1].abs_diff(grey[2]) <= 1, "{grey:?}");
    }

    #[test]
    fn trim_finds_the_box_of_what_differs_from_the_corner() {
        let image = rgb(8, 6, |x, y| if (2..5).contains(&x) && (1..3).contains(&y) { [255, 0, 0] } else { [0, 0, 0] });
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (2, 1, 3, 2));
    }

    #[test]
    fn trim_of_a_transparent_canvas_keeps_the_painted_box() {
        let mut bytes = vec![0u8; 6 * 4 * 4];
        let at = (2 * 6 + 3) * 4;
        bytes[at..at + 4].copy_from_slice(&[10, 20, 30, 255]);
        let image = Image::from_raw(6, 4, 4, &bytes).unwrap();
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (3, 2, 1, 1));
    }
}
