//! The geometry and colour operations: resize (every fit, gravity and kernel), extract, extend, greyscale, linear,
//! modulate and trim, as sharp runs them.
//!
//! Resampling follows libvips's pipeline as sharp drives it, in integers: colour premultiplied by alpha and cut to
//! bytes, the vertical axis then the horizontal one, an integer box shrink while the rest of the shrink stays at least
//! 2 and a reduce with the kernel on 64 phases and taps of 4096 ths for the rest, the affine interpolators (nearest,
//! bilinear, bicubic) when an axis is enlarged, and the premultiplication undone at the end.

use std::sync::OnceLock;

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

/// Bits of a resampling weight: libvips's integer taps are the kernel scaled by 4096 and cut toward zero.
const WEIGHT_BITS: u32 = 12;
/// libvips places the fraction of a source position on a grid of 1/64.
const PHASES: f64 = 64.0;

/// One image in the working format: four bands per pixel, signed so that a pass may overshoot before the clip.
struct Plane {
    width: usize,
    height: usize,
    data: Vec<i32>,
}

impl Plane {
    fn len(&self, axis: Axis) -> usize {
        match axis {
            Axis::Y => self.height,
            Axis::X => self.width,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    X,
    Y,
}

/// Builds the output of one axis: `taps` names, for an output index, the input lines it reads and their integer
/// weights; `finish` turns the weighted sum into the stored value.
fn map_axis(src: &Plane, axis: Axis, out_len: usize, mut taps: impl FnMut(usize) -> Vec<(usize, i64)>, finish: impl Fn(i64) -> i32) -> Plane {
    let (width, height) = match axis {
        Axis::X => (out_len, src.height),
        Axis::Y => (src.width, out_len),
    };
    let mut data = vec![0i32; width * height * 4];
    for o in 0..out_len {
        let line = taps(o);
        match axis {
            Axis::Y => {
                for x in 0..width {
                    for c in 0..4 {
                        let mut sum = 0i64;
                        for &(k, w) in &line {
                            sum += w * i64::from(src.data[(k * src.width + x) * 4 + c]);
                        }
                        data[(o * width + x) * 4 + c] = finish(sum);
                    }
                }
            }
            Axis::X => {
                for y in 0..height {
                    for c in 0..4 {
                        let mut sum = 0i64;
                        for &(k, w) in &line {
                            sum += w * i64::from(src.data[(y * src.width + k) * 4 + c]);
                        }
                        data[(y * width + o) * 4 + c] = finish(sum);
                    }
                }
            }
        }
    }
    Plane { width, height, data }
}

fn clip_byte(value: i64) -> i32 {
    value.clamp(0, 255) as i32
}

/// The fraction of a source position, on libvips's grid of 1/64.
fn phase(fraction: f64) -> f64 {
    (fraction * PHASES + 0.5).floor() / PHASES
}

/// libvips's integer shrink: the mean of `factor` neighbours (the last line repeated to fill a short box), rounded.
fn shrink(src: &Plane, axis: Axis, factor: usize) -> Plane {
    let n = src.len(axis);
    let out = n.div_ceil(factor);
    map_axis(
        src,
        axis,
        out,
        |o| (0..factor).map(|i| ((o * factor + i).min(n - 1), 1)).collect(),
        |sum| ((sum + (factor as i64) / 2) / factor as i64) as i32,
    )
}

/// libvips's reduce of one axis by `shrink` (at least 1) with `kernel`: the source position of an output sample is
/// centred between the sample centres, the output is centred on the input, the fraction takes one of 64 phases and
/// the taps are the kernel scaled by the shrink, normalised, scaled by 4096 and cut toward zero.
fn reduce(src: &Plane, axis: Axis, out_len: usize, shrink: f64, kernel: Kernel) -> Plane {
    let n = src.len(axis);
    let offset = (n as f64 - out_len as f64 * shrink) / 2.0;
    let last = n as i64 - 1;
    let scale = (1i64 << WEIGHT_BITS) as f64;
    map_axis(
        src,
        axis,
        out_len,
        |o| {
            if kernel == Kernel::Nearest {
                // The nearest kernel takes the sample the output centre falls in.
                let at = ((o as f64 + 0.5) * shrink + offset).floor() as i64;
                return vec![(at.clamp(0, last) as usize, 1i64 << WEIGHT_BITS)];
            }
            let position = (o as f64 + 0.5) * shrink - 0.5 + offset;
            let base = position.floor();
            let fraction = phase(position - base);
            let reach = kernel.support() * shrink;
            let first = (fraction - reach).ceil() as i64;
            let end = (fraction + reach).floor() as i64;
            let weights: Vec<(i64, f64)> = (first..=end).map(|k| (k, kernel.weight((k as f64 - fraction) / shrink))).collect();
            let sum: f64 = weights.iter().map(|(_, w)| w).sum();
            weights.into_iter().map(|(k, w)| (((base as i64 + k).clamp(0, last)) as usize, (w / sum * scale).trunc() as i64)).collect()
        },
        |sum| clip_byte((sum + (1i64 << (WEIGHT_BITS - 1))) >> WEIGHT_BITS),
    )
}

/// Where libvips's affine reads for output sample `o` when it enlarges by 1 / `inverse`: the x positions are a running
/// sum that starts at 1 (the rounding of the sum is part of what nearest picks), the y positions are products.
fn enlarge_positions(len: usize, inverse: f64, axis: Axis) -> Vec<f64> {
    match axis {
        Axis::X => {
            let mut running = 1.0f64;
            (0..len)
                .map(|_| {
                    let at = running - 1.0;
                    running += inverse;
                    at
                })
                .collect()
        }
        Axis::Y => (0..len).map(|o| o as f64 * inverse).collect(),
    }
}

/// The enlarging pass of one axis for the nearest kernel.
fn enlarge_nearest(src: &Plane, axis: Axis, out_len: usize, inverse: f64) -> Plane {
    let last = src.len(axis) as i64 - 1;
    let positions = enlarge_positions(out_len, inverse, axis);
    map_axis(src, axis, out_len, |o| vec![(positions[o].floor().clamp(0.0, last as f64) as usize, 1)], |sum| sum as i32)
}

/// The enlarging pass of one axis with libvips's bicubic (Catmull-Rom) interpolator; an intermediate may overshoot,
/// the clip comes after the last pass.
fn enlarge_cubic(src: &Plane, axis: Axis, out_len: usize, inverse: f64) -> Plane {
    let last = src.len(axis) as i64 - 1;
    let positions = enlarge_positions(out_len, inverse, axis);
    let scale = (1i64 << WEIGHT_BITS) as f64;
    map_axis(
        src,
        axis,
        out_len,
        |o| {
            let position = positions[o] - 0.5;
            let base = position.floor();
            let fraction = phase(position - base);
            (-1..=2i64).map(|t| (((base as i64 + t).clamp(0, last)) as usize, (Kernel::Cubic.weight(t as f64 - fraction) * scale).trunc() as i64)).collect()
        },
        |sum| ((sum + (1i64 << (WEIGHT_BITS - 1))) >> WEIGHT_BITS) as i32,
    )
}

/// The enlarging pass with libvips's bilinear interpolator: both axes at once, the fractions in 12 bits, one rounding.
fn enlarge_linear(src: &Plane, out_w: usize, out_h: usize, x_inverse: Option<f64>, y_inverse: Option<f64>) -> Plane {
    let unit = 1i64 << WEIGHT_BITS;
    let axis_taps = |len: usize, out: usize, inverse: Option<f64>, axis: Axis| -> Vec<(usize, usize, i64)> {
        let last = len as i64 - 1;
        match inverse {
            None => (0..out).map(|o| (o.min(len - 1), o.min(len - 1), 0)).collect(),
            Some(inverse) => enlarge_positions(out, inverse, axis)
                .into_iter()
                .map(|at| {
                    let position = at - 0.5;
                    let base = position.floor();
                    let weight = ((position - base) * unit as f64 + 0.5).floor() as i64;
                    ((base as i64).clamp(0, last) as usize, (base as i64 + 1).clamp(0, last) as usize, weight)
                })
                .collect(),
        }
    };
    let xs = axis_taps(src.width, out_w, x_inverse, Axis::X);
    let ys = axis_taps(src.height, out_h, y_inverse, Axis::Y);
    let mut data = vec![0i32; out_w * out_h * 4];
    for (oy, &(y0, y1, wy)) in ys.iter().enumerate() {
        for (ox, &(x0, x1, wx)) in xs.iter().enumerate() {
            for c in 0..4 {
                let at = |y: usize, x: usize| i64::from(src.data[(y * src.width + x) * 4 + c]);
                let sum = at(y0, x0) * (unit - wx) * (unit - wy) + at(y0, x1) * wx * (unit - wy) + at(y1, x0) * (unit - wx) * wy + at(y1, x1) * wx * wy;
                data[(oy * out_w + ox) * 4 + c] = clip_byte((sum + (1i64 << (2 * WEIGHT_BITS - 1))) >> (2 * WEIGHT_BITS));
            }
        }
    }
    Plane { width: out_w, height: out_h, data }
}

/// libvips's resize of one axis that shrinks: an integer box shrink while the rest stays at least 2, then the reduce.
fn shrink_axis(src: &Plane, axis: Axis, out_len: usize, factor: f64, kernel: Kernel) -> Plane {
    let whole = if kernel == Kernel::Nearest { 1 } else { ((factor / 2.0).floor() as usize).max(1) };
    if whole > 1 {
        let shrunk = shrink(src, axis, whole);
        reduce(&shrunk, axis, out_len, factor / whole as f64, kernel)
    } else {
        reduce(src, axis, out_len, factor, kernel)
    }
}

fn to_byte(value: f32) -> u8 {
    (value + 0.5).clamp(0.0, 255.0) as u8
}

/// The band count sharp hands back: a grey image comes out in sRGB with its colour bands.
fn colour_channels(channels: u8) -> u8 {
    match channels {
        1 => 3,
        2 => 4,
        other => other,
    }
}

/// The image resampled to `width` x `height` as libvips does for sharp: `x_factor` and `y_factor` are the input
/// length over the length the scale stands for (not always the output length: `cover` and `inside` keep one
/// factor on both axes and round the size). An axis with a factor above 1 is shrunk (vertical first, each pass kept
/// in bytes), one below 1 is enlarged by the affine interpolator that goes with the kernel. Colour is premultiplied
/// by alpha, cut to bytes, around the resampling when the image has alpha.
fn resample(image: &Image, width: u32, height: u32, x_factor: f64, y_factor: f64, kernel: Kernel) -> Image {
    let alpha = image.has_alpha();
    let mut plane = Plane { width: image.width() as usize, height: image.height() as usize, data: Vec::with_capacity(image.rgba().len()) };
    for pixel in image.rgba().chunks_exact(4) {
        if alpha {
            let factor = f32::from(pixel[3]) / 255.0;
            plane.data.extend_from_slice(&[
                (f32::from(pixel[0]) * factor) as i32,
                (f32::from(pixel[1]) * factor) as i32,
                (f32::from(pixel[2]) * factor) as i32,
                i32::from(pixel[3]),
            ]);
        } else {
            plane.data.extend(pixel.iter().map(|b| i32::from(*b)));
        }
    }
    let (out_w, out_h) = (width as usize, height as usize);
    if y_factor > 1.0 {
        plane = shrink_axis(&plane, Axis::Y, out_h, y_factor, kernel);
    }
    if x_factor > 1.0 {
        plane = shrink_axis(&plane, Axis::X, out_w, x_factor, kernel);
    }
    if x_factor < 1.0 || y_factor < 1.0 {
        let x_inverse = (x_factor < 1.0).then_some(x_factor);
        let y_inverse = (y_factor < 1.0).then_some(y_factor);
        plane = match kernel {
            Kernel::Linear => enlarge_linear(&plane, out_w, out_h, x_inverse, y_inverse),
            Kernel::Nearest => {
                if let Some(inverse) = x_inverse {
                    plane = enlarge_nearest(&plane, Axis::X, out_w, inverse);
                }
                if let Some(inverse) = y_inverse {
                    plane = enlarge_nearest(&plane, Axis::Y, out_h, inverse);
                }
                plane
            }
            _ => {
                if let Some(inverse) = x_inverse {
                    plane = enlarge_cubic(&plane, Axis::X, out_w, inverse);
                }
                if let Some(inverse) = y_inverse {
                    plane = enlarge_cubic(&plane, Axis::Y, out_h, inverse);
                }
                plane
            }
        };
    }
    let mut data = Vec::with_capacity(plane.data.len());
    for pixel in plane.data.chunks_exact(4) {
        let alpha_value = pixel[3].clamp(0, 255);
        if alpha {
            // The premultiplied colour goes back to bytes first, then is divided by alpha and cut.
            let gain = if alpha_value > 0 { 255.0f32 / alpha_value as f32 } else { 0.0 };
            for c in &pixel[..3] {
                data.push(((*c).clamp(0, 255) as f32 * gain).clamp(0.0, 255.0) as u8);
            }
            data.push(alpha_value as u8);
        } else {
            data.extend(pixel[..3].iter().map(|c| (*c).clamp(0, 255) as u8));
            data.push(255);
        }
    }
    Image::from_rgba(width, height, colour_channels(image.channels()), data)
}

/// The image resampled to exactly `width` x `height` (sharp's `fill`).
pub fn resize_exact(image: &Image, width: u32, height: u32, kernel: Kernel) -> Image {
    if (width, height) == (image.width(), image.height()) {
        return image.clone();
    }
    resample(image, width, height, f64::from(image.width()) / f64::from(width), f64::from(image.height()) / f64::from(height), kernel)
}

/// `resize(width, height, options)`: with one side only the other follows the aspect ratio.
pub fn resize(image: &Image, options: &ResizeOptions) -> Result<Image, RasterError> {
    let (iw, ih) = (image.width(), image.height());
    if options.width.is_none() && options.height.is_none() {
        return Ok(image.clone());
    }
    if options.width == Some(0) || options.height == Some(0) {
        return Err(RasterError::new("Expected positive integer for width and height"));
    }
    let rounded = |value: f64| (value.round() as u32).max(1);
    // sharp's factors: the input over the requested size; a missing side takes the other side's factor.
    let (w, h, mut x_factor, mut y_factor) = match (options.width, options.height) {
        (Some(w), Some(h)) => (w, h, f64::from(iw) / f64::from(w), f64::from(ih) / f64::from(h)),
        (Some(w), None) => {
            let factor = f64::from(iw) / f64::from(w);
            (w, rounded(f64::from(ih) / factor), factor, factor)
        }
        (None, Some(h)) => {
            let factor = f64::from(ih) / f64::from(h);
            (rounded(f64::from(iw) / factor), h, factor, factor)
        }
        (None, None) => return Ok(image.clone()),
    };
    let kernel = options.kernel;
    let (mut rw, mut rh) = (w, h);
    match options.fit {
        Fit::Fill => {}
        Fit::Inside | Fit::Contain => {
            if x_factor > y_factor {
                rh = rounded(f64::from(ih) / x_factor);
                y_factor = x_factor;
            } else {
                rw = rounded(f64::from(iw) / y_factor);
                x_factor = y_factor;
            }
        }
        Fit::Outside | Fit::Cover => {
            if x_factor < y_factor {
                rh = rounded(f64::from(ih) / x_factor);
                y_factor = x_factor;
            } else {
                rw = rounded(f64::from(iw) / y_factor);
                x_factor = y_factor;
            }
        }
    }
    let source = if options.fit == Fit::Contain && options.background[3] < 255 { image.ensure_alpha() } else { image.clone() };
    let resized = if x_factor == 1.0 && y_factor == 1.0 {
        Image::from_rgba(source.width(), source.height(), colour_channels(source.channels()), source.rgba().to_vec())
    } else {
        resample(&source, rw, rh, x_factor, y_factor, kernel)
    };
    match options.fit {
        Fit::Fill | Fit::Inside | Fit::Outside => Ok(resized),
        Fit::Contain => {
            // The canvas is laid while the picture still has its own bands: a grey picture takes the grey of the
            // background colour; the colour bands come after.
            let mut background = options.background;
            if source.channels() <= 2 {
                let grey = (0.2126 * f64::from(background[0]) + 0.7152 * f64::from(background[1]) + 0.0722 * f64::from(background[2])).round() as u8;
                background = [grey, grey, grey, background[3]];
            }
            let narrow = Image::from_rgba(resized.width(), resized.height(), source.channels(), resized.rgba().to_vec());
            let placed = embed(&narrow, w, h, options.position, background);
            Ok(Image::from_rgba(placed.width(), placed.height(), colour_channels(placed.channels()), placed.rgba().to_vec()))
        }
        Fit::Cover => {
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
        data.extend_from_slice(&[grey, grey, grey, 255]);
    }
    Image::from_rgba(image.width(), image.height(), 1, data)
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

/// The middle of nine values (a sorting network of 19 exchanges): libvips's `median` of a 3 x 3 window.
fn median9(mut v: [u8; 9]) -> u8 {
    macro_rules! swap {
        ($a:expr, $b:expr) => {
            if v[$a] > v[$b] {
                v.swap($a, $b);
            }
        };
    }
    swap!(1, 2);
    swap!(4, 5);
    swap!(7, 8);
    swap!(0, 1);
    swap!(3, 4);
    swap!(6, 7);
    swap!(1, 2);
    swap!(4, 5);
    swap!(7, 8);
    swap!(0, 3);
    swap!(5, 8);
    swap!(4, 7);
    swap!(3, 6);
    swap!(1, 4);
    swap!(2, 5);
    swap!(4, 7);
    swap!(4, 2);
    swap!(6, 4);
    swap!(4, 2);
    v[4]
}

/// `trim({ threshold })`: the box of pixels that differ from the top-left pixel by more than `threshold` in a band, as
/// sharp finds it with libvips's `find_trim`: once over the colour (flattened against the top-left pixel's colour) and,
/// when there is alpha, once more over the alpha band alone, the two boxes combined. Each search smooths its bands by a
/// 3 x 3 median first, so a speck of one pixel is no content and a faint shadow over a transparent corner is. An image
/// with nothing different is returned whole.
pub fn trim(image: &Image, threshold: f64) -> Result<Trimmed, RasterError> {
    let first = &image.rgba()[..4];
    let background = [first[0], first[1], first[2], first[3]];
    let (w, h) = (image.width() as usize, image.height() as usize);
    let flat = image.flatten([first[0], first[1], first[2]]);
    let (colour, alpha) = (flat.rgba(), image.rgba());
    let bands = if image.has_alpha() { 4 } else { 3 };
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (w, h, 0usize, 0usize);
    for y in 0..h {
        let rows = [y.saturating_sub(1), y, (y + 1).min(h - 1)];
        for x in 0..w {
            let columns = [x.saturating_sub(1), x, (x + 1).min(w - 1)];
            let differs = (0..bands).any(|c| {
                let data = if c < 3 { colour } else { alpha };
                let mut window = [0u8; 9];
                for (r, row) in rows.iter().enumerate() {
                    for (k, column) in columns.iter().enumerate() {
                        window[r * 3 + k] = data[(row * w + column) * 4 + c];
                    }
                }
                (f64::from(median9(window)) - f64::from(background[c])).abs() > threshold
            });
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
        // find_trim smooths with a 3x3 median first: a 3x3 block keeps its whole box, a lone pixel is noise.
        let image = rgb(8, 6, |x, y| if (2..5).contains(&x) && (1..4).contains(&y) { [255, 0, 0] } else { [0, 0, 0] });
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (2, 1, 3, 3));
        let lone = rgb(8, 6, |x, y| if (x, y) == (3, 2) { [255, 0, 0] } else { [0, 0, 0] });
        let cut = trim(&lone, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (0, 0, 8, 6));
        let image = rgb(10, 8, |x, y| if (2..8).contains(&x) && (2..6).contains(&y) { [255, 0, 0] } else { [0, 0, 0] });
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (2, 2, 6, 4));
    }

    #[test]
    fn trim_of_a_transparent_canvas_keeps_the_painted_box_and_not_a_speck() {
        let mut bytes = vec![0u8; 6 * 4 * 4];
        let at = (2 * 6 + 3) * 4;
        bytes[at..at + 4].copy_from_slice(&[10, 20, 30, 255]);
        let image = Image::from_raw(6, 4, 4, &bytes).unwrap();
        // The 3 x 3 median that smooths the image first takes a single pixel for noise: nothing differs, the image comes back whole.
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (0, 0, 6, 4));
        // A faint shadow (alpha only, black over a transparent corner) is painted.
        let mut bytes = vec![0u8; 10 * 8 * 4];
        for y in 2..6 {
            for x in 2..8 {
                bytes[(y * 10 + x) * 4 + 3] = 70;
            }
        }
        let image = Image::from_raw(10, 8, 4, &bytes).unwrap();
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (2, 2, 6, 4));
        // A lone pixel does not survive the 3x3 median of find_trim; a 3x3 block does, whole.
        let mut bytes = vec![0u8; 8 * 6 * 4];
        for y in 2..5 {
            for x in 3..6 {
                let at = (y * 8 + x) * 4;
                bytes[at..at + 4].copy_from_slice(&[10, 20, 30, 255]);
            }
        }
        let image = Image::from_raw(8, 6, 4, &bytes).unwrap();
        let cut = trim(&image, 0.0).unwrap();
        assert_eq!((cut.left, cut.top, cut.image.width(), cut.image.height()), (3, 2, 3, 3));
    }
}
