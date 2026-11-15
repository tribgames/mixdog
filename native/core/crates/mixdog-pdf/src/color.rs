//! Colour spaces as pdf.js 6.4 converts them to RGB in the Node configurations (`colorspace.js`,
//! `colorspace_utils.js`): DeviceGray, DeviceRGB, DeviceRGBA, DeviceCMYK (pdf.js's polynomial), CalGray, CalRGB (single
//! precision temporaries as pdf.js keeps them in `Float32Array`s), Lab, Indexed, Separation and DeviceN (an alternate
//! space through a tint function) and the Pattern placeholder. ICCBased is built as pdf.js builds it without
//! `wasmUrl`: qcms is not loaded, so the `/Alternate` space with the right number of components, else the device space
//! of `/N`, decides (the recorded twin asserts that pdf.js on this configuration does the same).
//!
//! Every conversion writes bytes as a `Uint8ClampedArray` stores a number: `NaN` is 0, the rest is clamped to 0..255
//! and rounded half to even. Sources are read as `f64` (a typed array's elements widened); a read past the end of a
//! source is `NaN` and a write past the end of a destination is dropped, as with typed arrays. `fillRgb` is here
//! too, with the three resizers it calls.
//!
//! Not carried over: pdf.js's per-document caches of parsed colour spaces (they change no result), and the stale
//! scratch values pdf.js's tint transform keeps between calls when a function writes fewer outputs than the base
//! space has components.

use std::sync::{Arc, OnceLock};

use mixdog_js::math as js;

use crate::error::{PdfError, Result};
use crate::function::{self, PdfFunction, clamp};
use crate::object::{Dict, Obj};
use crate::xref::Xref;

/// Nesting of colour spaces one parse follows (pdf.js recurses until the stack runs out).
const MAX_DEPTH: usize = 32;

fn format_error(message: &str) -> PdfError {
    PdfError::Format(message.to_owned())
}

// ---- typed array stores and loads ----------------------------------------------------------------------------------

/// What a `Uint8ClampedArray` stores for the number `x`.
pub fn to_u8_clamped(x: f64) -> u8 {
    if x.is_nan() || x <= 0.0 {
        return 0;
    }
    if x >= 255.0 {
        return 255;
    }
    let floor = x.floor();
    let fraction = x - floor;
    let rounded = if fraction < 0.5 {
        floor
    } else if fraction > 0.5 {
        floor + 1.0
    } else if floor % 2.0 == 0.0 {
        floor
    } else {
        floor + 1.0
    };
    rounded as u8
}

fn store(dest: &mut [u8], at: usize, value: f64) {
    if let Some(slot) = dest.get_mut(at) {
        *slot = to_u8_clamped(value);
    }
}

fn load<T: Copy + Into<f64>>(src: &[T], at: usize) -> f64 {
    src.get(at).map_or(f64::NAN, |v| (*v).into())
}

fn float32(x: f64) -> f64 {
    f64::from(x as f32)
}

/// `Util.makeHexColor`.
pub fn make_hex_color(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

// ---- the spaces ----------------------------------------------------------------------------------------------------

struct CalGray {
    yw: f64,
    gamma: f64,
}

struct CalRgb {
    white_point: [f64; 3],
    black_point: [f64; 3],
    gamma: [f64; 3],
    matrix: [f64; 9],
}

struct Lab {
    xw: f64,
    yw: f64,
    zw: f64,
    amin: f64,
    amax: f64,
    bmin: f64,
    bmax: f64,
}

struct Indexed {
    high_val: f64,
    rgb_lookup: Vec<u8>,
}

struct Alternate {
    num_comps: usize,
    base: Arc<ColorSpace>,
    tint: PdfFunction,
}

enum Kind {
    Gray,
    Rgb,
    Rgba,
    Cmyk,
    CalGray(CalGray),
    CalRgb(CalRgb),
    Lab(Lab),
    Indexed(Indexed),
    Alternate(Alternate),
    Pattern(Option<Arc<ColorSpace>>),
}

/// A colour space of a document.
pub struct ColorSpace {
    kind: Kind,
}

/// A `Float32Array` element: the decimal read as a double first, as JavaScript reads it, then rounded to single.
const fn single(x: f64) -> f32 {
    x as f32
}

const BRADFORD_SCALE_MATRIX: [f32; 9] = [
    single(0.8951),
    single(0.2664),
    single(-0.1614),
    single(-0.7502),
    single(1.7135),
    single(0.0367),
    single(0.0389),
    single(-0.0685),
    single(1.0296),
];
const BRADFORD_SCALE_INVERSE_MATRIX: [f32; 9] = [
    single(0.9869929),
    single(-0.1470543),
    single(0.1599627),
    single(0.4323053),
    single(0.5183603),
    single(0.0492912),
    single(-0.0085287),
    single(0.0400428),
    single(0.9684867),
];
const SRGB_D65_XYZ_TO_RGB_MATRIX: [f32; 9] = [
    single(3.2404542),
    single(-1.5371385),
    single(-0.4985314),
    single(-0.969266),
    single(1.8760108),
    single(0.041556),
    single(0.0556434),
    single(-0.2040259),
    single(1.0572252),
];

/// `matrixProduct(a, b, result)` over `Float32Array`s.
fn matrix_product(a: &[f32; 9], b: &[f32; 3]) -> [f32; 3] {
    let m = |i: usize| f64::from(a[i]);
    let v = |i: usize| f64::from(b[i]);
    [
        (m(0) * v(0) + m(1) * v(1) + m(2) * v(2)) as f32,
        (m(3) * v(0) + m(4) * v(1) + m(5) * v(2)) as f32,
        (m(6) * v(0) + m(7) * v(1) + m(8) * v(2)) as f32,
    ]
}

fn srgb_transfer_function(color: f64) -> f64 {
    if color <= 0.0031308 {
        return clamp(12.92 * color, 0.0, 1.0);
    }
    if color >= 0.99554525 {
        1.0
    } else {
        clamp((1.0 + 0.055) * js::pow(color, 1.0 / 2.4) - 0.055, 0.0, 1.0)
    }
}

fn decode_l_constant() -> f64 {
    js::pow((8.0 + 16.0) / 116.0, 3.0) / 8.0
}

fn decode_l(l: f64) -> f64 {
    if l < 0.0 {
        return -decode_l(-l);
    }
    if l > 8.0 {
        js::pow((l + 16.0) / 116.0, 3.0)
    } else {
        l * decode_l_constant()
    }
}

fn compensate_black_point(source_black_point: &[f64; 3], xyz_flat: &[f32; 3]) -> [f32; 3] {
    if source_black_point.iter().all(|v| *v == 0.0) {
        return *xyz_flat;
    }
    let zero_decode_l = decode_l(0.0);
    let x_dst = zero_decode_l;
    let x_src = decode_l(source_black_point[0]);
    let y_dst = zero_decode_l;
    let y_src = decode_l(source_black_point[1]);
    let z_dst = zero_decode_l;
    let z_src = decode_l(source_black_point[2]);
    let x_scale = (1.0 - x_dst) / (1.0 - x_src);
    let x_offset = 1.0 - x_scale;
    let y_scale = (1.0 - y_dst) / (1.0 - y_src);
    let y_offset = 1.0 - y_scale;
    let z_scale = (1.0 - z_dst) / (1.0 - z_src);
    let z_offset = 1.0 - z_scale;
    [
        (f64::from(xyz_flat[0]) * x_scale + x_offset) as f32,
        (f64::from(xyz_flat[1]) * y_scale + y_offset) as f32,
        (f64::from(xyz_flat[2]) * z_scale + z_offset) as f32,
    ]
}

fn normalize_white_point_to_flat(source_white_point: &[f64; 3], xyz_in: &[f32; 3]) -> [f32; 3] {
    if source_white_point[0] == 1.0 && source_white_point[2] == 1.0 {
        return *xyz_in;
    }
    let lms = matrix_product(&BRADFORD_SCALE_MATRIX, xyz_in);
    let lms_flat = [
        (f64::from(lms[0]) * 1.0 / source_white_point[0]) as f32,
        (f64::from(lms[1]) * 1.0 / source_white_point[1]) as f32,
        (f64::from(lms[2]) * 1.0 / source_white_point[2]) as f32,
    ];
    matrix_product(&BRADFORD_SCALE_INVERSE_MATRIX, &lms_flat)
}

/// The white point is the flat `[1, 1, 1]` in the only call pdf.js makes.
fn normalize_flat_white_point_to_d65(xyz_in: &[f32; 3]) -> [f32; 3] {
    const D65_X: f64 = 0.95047;
    const D65_Y: f64 = 1.0;
    const D65_Z: f64 = 1.08883;
    let lms = matrix_product(&BRADFORD_SCALE_MATRIX, xyz_in);
    let lms_d65 = [
        (f64::from(lms[0]) * D65_X / 1.0) as f32,
        (f64::from(lms[1]) * D65_Y / 1.0) as f32,
        (f64::from(lms[2]) * D65_Z / 1.0) as f32,
    ];
    matrix_product(&BRADFORD_SCALE_INVERSE_MATRIX, &lms_d65)
}

impl CalGray {
    fn to_rgb(&self, src_value: f64, scale: f64) -> f64 {
        let a = src_value * scale;
        let ag = js::pow(a, self.gamma);
        let l = self.yw * ag;
        js::max(295.8 * js::pow(l, 0.3333333333333333) - 40.8, 0.0)
    }
}

impl CalRgb {
    fn to_rgb(&self, a: f64, b: f64, c: f64, scale: f64) -> [f64; 3] {
        let a = clamp(a * scale, 0.0, 1.0);
        let b = clamp(b * scale, 0.0, 1.0);
        let c = clamp(c * scale, 0.0, 1.0);
        let agr = if a == 1.0 {
            1.0
        } else {
            js::pow(a, self.gamma[0])
        };
        let bgg = if b == 1.0 {
            1.0
        } else {
            js::pow(b, self.gamma[1])
        };
        let cgb = if c == 1.0 {
            1.0
        } else {
            js::pow(c, self.gamma[2])
        };
        let m = &self.matrix;
        let x = m[0] * agr + m[3] * bgg + m[6] * cgb;
        let y = m[1] * agr + m[4] * bgg + m[7] * cgb;
        let z = m[2] * agr + m[5] * bgg + m[8] * cgb;
        let xyz = [x as f32, y as f32, z as f32];
        let xyz_flat = normalize_white_point_to_flat(&self.white_point, &xyz);
        let xyz_black = compensate_black_point(&self.black_point, &xyz_flat);
        let xyz_d65 = normalize_flat_white_point_to_d65(&xyz_black);
        let srgb = matrix_product(&SRGB_D65_XYZ_TO_RGB_MATRIX, &xyz_d65);
        [
            srgb_transfer_function(f64::from(srgb[0])) * 255.0,
            srgb_transfer_function(f64::from(srgb[1])) * 255.0,
            srgb_transfer_function(f64::from(srgb[2])) * 255.0,
        ]
    }
}

impl Lab {
    fn fn_g(x: f64) -> f64 {
        if x >= 6.0 / 29.0 {
            js::pow(x, 3.0)
        } else {
            108.0 / 841.0 * (x - 4.0 / 29.0)
        }
    }

    fn decode(value: f64, high1: f64, low2: f64, high2: f64) -> f64 {
        low2 + value * (high2 - low2) / high1
    }

    /// `max_val` is `None` for `getRgbItem` (`false` in pdf.js).
    fn to_rgb(&self, ls: f64, a_s: f64, b_s: f64, max_val: Option<f64>) -> [f64; 3] {
        let (mut ls, mut a_s, mut b_s) = (ls, a_s, b_s);
        if let Some(max_val) = max_val {
            ls = Self::decode(ls, max_val, 0.0, 100.0);
            a_s = Self::decode(a_s, max_val, self.amin, self.amax);
            b_s = Self::decode(b_s, max_val, self.bmin, self.bmax);
        }
        if a_s > self.amax {
            a_s = self.amax;
        } else if a_s < self.amin {
            a_s = self.amin;
        }
        if b_s > self.bmax {
            b_s = self.bmax;
        } else if b_s < self.bmin {
            b_s = self.bmin;
        }
        let m = (ls + 16.0) / 116.0;
        let l = m + a_s / 500.0;
        let n = m - b_s / 200.0;
        let x = self.xw * Self::fn_g(l);
        let y = self.yw * Self::fn_g(m);
        let z = self.zw * Self::fn_g(n);
        let (r, g, b) = if self.zw < 1.0 {
            (
                x * 3.1339 + y * -1.617 + z * -0.4906,
                x * -0.9785 + y * 1.916 + z * 0.0333,
                x * 0.072 + y * -0.229 + z * 1.4057,
            )
        } else {
            (
                x * 3.2406 + y * -1.5372 + z * -0.4986,
                x * -0.9689 + y * 1.8758 + z * 0.0415,
                x * 0.0557 + y * -0.204 + z * 1.057,
            )
        };
        [r.sqrt() * 255.0, g.sqrt() * 255.0, b.sqrt() * 255.0]
    }
}

/// `DeviceCmykCS.#toRgb`: pdf.js's polynomial, the operations in the order it writes them.
fn cmyk_to_rgb(c: f64, m: f64, y: f64, k: f64) -> [f64; 3] {
    [
        255.0
            + c * (-4.387332384609988 * c
                + 54.48615194189176 * m
                + 18.82290502165302 * y
                + 212.25662451639585 * k
                + -285.2331026137004)
            + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k
                - 5.497006427196366)
            + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813)
            + k * (-21.86122147463605 * k - 189.48180835922747),
        255.0
            + c * (8.841041422036149 * c
                + 60.118027045597366 * m
                + 6.871425592049007 * y
                + 31.159100130055922 * k
                + -79.2970844816548)
            + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k
                - 190.9453302588951)
            + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878)
            + k * (-20.737325471181034 * k - 187.80453709719578),
        255.0
            + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y
                - 0.23883238689178934 * k
                + -14.183576799673286)
            + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k
                - 112.23884253719248)
            + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505)
            + k * (-22.33816807309886 * k - 180.12613974708367),
    ]
}

fn is_default_decode_helper(decode: Option<&[f64]>, expected_len: usize) -> bool {
    match decode {
        None => true,
        Some(decode) if decode.len() < expected_len => {
            tracing::debug!("Decode map length is too short.");
            true
        }
        Some(_) => false,
    }
}

fn gray_space() -> Arc<ColorSpace> {
    static SPACE: OnceLock<Arc<ColorSpace>> = OnceLock::new();
    SPACE
        .get_or_init(|| Arc::new(ColorSpace { kind: Kind::Gray }))
        .clone()
}

fn rgb_space() -> Arc<ColorSpace> {
    static SPACE: OnceLock<Arc<ColorSpace>> = OnceLock::new();
    SPACE
        .get_or_init(|| Arc::new(ColorSpace { kind: Kind::Rgb }))
        .clone()
}

fn rgba_space() -> Arc<ColorSpace> {
    static SPACE: OnceLock<Arc<ColorSpace>> = OnceLock::new();
    SPACE
        .get_or_init(|| Arc::new(ColorSpace { kind: Kind::Rgba }))
        .clone()
}

fn cmyk_space() -> Arc<ColorSpace> {
    static SPACE: OnceLock<Arc<ColorSpace>> = OnceLock::new();
    SPACE
        .get_or_init(|| Arc::new(ColorSpace { kind: Kind::Cmyk }))
        .clone()
}

impl ColorSpace {
    /// `ColorSpaceUtils.gray`.
    pub fn gray() -> Arc<ColorSpace> {
        gray_space()
    }

    /// `ColorSpaceUtils.rgb`.
    pub fn rgb() -> Arc<ColorSpace> {
        rgb_space()
    }

    /// `ColorSpaceUtils.rgba`.
    pub fn rgba() -> Arc<ColorSpace> {
        rgba_space()
    }

    /// `ColorSpaceUtils.cmyk`: DeviceCMYK (qcms is not available, so never the ICC profile).
    pub fn cmyk() -> Arc<ColorSpace> {
        cmyk_space()
    }

    /// `cs.name`.
    pub fn name(&self) -> &'static str {
        match &self.kind {
            Kind::Gray => "DeviceGray",
            Kind::Rgb => "DeviceRGB",
            Kind::Rgba => "DeviceRGBA",
            Kind::Cmyk => "DeviceCMYK",
            Kind::CalGray(_) => "CalGray",
            Kind::CalRgb(_) => "CalRGB",
            Kind::Lab(_) => "Lab",
            Kind::Indexed(_) => "Indexed",
            Kind::Alternate(_) => "Alternate",
            Kind::Pattern(_) => "Pattern",
        }
    }

    /// `cs.numComps` (`null` for a Pattern space, 0 here).
    pub fn num_comps(&self) -> usize {
        match &self.kind {
            Kind::Gray | Kind::CalGray(_) | Kind::Indexed(_) => 1,
            Kind::Rgb | Kind::CalRgb(_) | Kind::Lab(_) => 3,
            Kind::Rgba | Kind::Cmyk => 4,
            Kind::Alternate(a) => a.num_comps,
            Kind::Pattern(_) => 0,
        }
    }

    /// The base space of a Pattern space (`cs.base`).
    pub fn pattern_base(&self) -> Option<&Arc<ColorSpace>> {
        match &self.kind {
            Kind::Pattern(base) => base.as_ref(),
            _ => None,
        }
    }

    /// `cs.usesZeroToOneRange`: false only for Lab.
    pub fn uses_zero_to_one_range(&self) -> bool {
        !matches!(self.kind, Kind::Lab(_))
    }

    /// `cs.isPassthrough(bits)`.
    pub fn is_passthrough(&self, bits: u32) -> bool {
        matches!(self.kind, Kind::Rgb | Kind::Rgba) && bits == 8
    }

    /// `cs.isDefaultDecode(decode, bpc)`. A Pattern space has none (pdf.js: unreachable).
    pub fn is_default_decode(&self, decode: Option<&[f64]>, bpc: f64) -> Result<bool> {
        match &self.kind {
            Kind::Pattern(_) => Err(format_error("Should not call PatternCS.isDefaultDecode")),
            Kind::Lab(_) => Ok(true),
            Kind::Indexed(_) => {
                if is_default_decode_helper(decode, 2) {
                    return Ok(true);
                }
                if bpc.fract() != 0.0 || bpc < 1.0 {
                    tracing::debug!("Bits per component is not correct");
                    return Ok(true);
                }
                let decode = decode.unwrap_or(&[]);
                Ok(decode[0] == 0.0 && decode[1] == ((1u64 << (bpc as u32).min(31)) - 1) as f64)
            }
            _ => Ok(is_default_decode(decode, self.num_comps())),
        }
    }

    /// `getRgbItem`: one colour from `src[src_offset..]` into `dest[dest_offset..]`.
    pub fn get_rgb_item(
        &self,
        src: &[f64],
        src_offset: usize,
        dest: &mut [u8],
        dest_offset: usize,
    ) -> Result<()> {
        match &self.kind {
            Kind::Gray => {
                let c = load(src, src_offset) * 255.0;
                for k in 0..3 {
                    store(dest, dest_offset + k, c);
                }
            }
            Kind::Rgb => {
                for k in 0..3 {
                    store(dest, dest_offset + k, load(src, src_offset + k) * 255.0);
                }
            }
            Kind::Rgba | Kind::Pattern(_) => {
                return Err(format_error("Should not call ColorSpace.getRgbItem"));
            }
            Kind::Cmyk => {
                let rgb = cmyk_to_rgb(
                    load(src, src_offset),
                    load(src, src_offset + 1),
                    load(src, src_offset + 2),
                    load(src, src_offset + 3),
                );
                store_rgb(dest, dest_offset, rgb);
            }
            Kind::CalGray(c) => {
                let val = c.to_rgb(load(src, src_offset), 1.0);
                for k in 0..3 {
                    store(dest, dest_offset + k, val);
                }
            }
            Kind::CalRgb(c) => {
                let rgb = c.to_rgb(
                    load(src, src_offset),
                    load(src, src_offset + 1),
                    load(src, src_offset + 2),
                    1.0,
                );
                store_rgb(dest, dest_offset, rgb);
            }
            Kind::Lab(l) => {
                let rgb = l.to_rgb(
                    load(src, src_offset),
                    load(src, src_offset + 1),
                    load(src, src_offset + 2),
                    None,
                );
                store_rgb(dest, dest_offset, rgb);
            }
            Kind::Indexed(i) => {
                let pos = indexed_position(load(src, src_offset), i.high_val);
                for k in 0..3 {
                    store(
                        dest,
                        dest_offset + k,
                        pos.map_or(f64::NAN, |p| f64::from(i.rgb_lookup[p + k])),
                    );
                }
            }
            Kind::Alternate(a) => {
                let mut tinted = vec![0.0f64; a.base.num_comps().max(a.tint.num_outputs())];
                a.tint
                    .call(src.get(src_offset..).unwrap_or(&[]), &mut tinted)?;
                round_to_f32(&mut tinted);
                a.base.get_rgb_item(&tinted, 0, dest, dest_offset)?;
            }
        }
        Ok(())
    }

    /// `getRgb`: the three bytes of one colour.
    pub fn get_rgb(&self, src: &[f64], src_offset: usize) -> Result<[u8; 3]> {
        let mut out = [0u8; 3];
        self.get_rgb_item(src, src_offset, &mut out, 0)?;
        Ok(out)
    }

    /// `getRgbHex`: `#rrggbb`.
    pub fn get_rgb_hex(&self, src: &[f64], src_offset: usize) -> Result<String> {
        let rgb = self.get_rgb(src, src_offset)?;
        Ok(make_hex_color(rgb[0], rgb[1], rgb[2]))
    }

    /// `getRgbItems`: `count` colours of `num_comps` values each, `3 + alpha01` bytes apart in `dest`.
    pub fn get_rgb_items(
        &self,
        src: &[f64],
        count: usize,
        dest: &mut [u8],
        dest_offset: usize,
        alpha01: usize,
    ) -> Result<()> {
        if let Kind::Alternate(a) = &self.kind {
            let base_num = a.base.num_comps();
            let outputs = base_num.max(a.tint.num_outputs());
            let mut tinted = vec![0.0f32; count * base_num];
            let mut scratch = vec![0.0f64; outputs];
            let (mut src_offset, mut tinted_offset) = (0usize, 0usize);
            for _ in 0..count {
                scratch.fill(0.0);
                a.tint
                    .call(src.get(src_offset..).unwrap_or(&[]), &mut scratch)?;
                for j in 0..base_num {
                    tinted[tinted_offset + j] = scratch[j] as f32;
                }
                src_offset += a.num_comps;
                tinted_offset += base_num;
            }
            let widened: Vec<f64> = tinted.iter().map(|v| f64::from(*v)).collect();
            return a
                .base
                .get_rgb_items(&widened, count, dest, dest_offset, alpha01);
        }
        let num_comps = self.num_comps();
        let mut dest_offset = dest_offset;
        let mut src_offset = 0;
        for _ in 0..count {
            self.get_rgb_item(src, src_offset, dest, dest_offset)?;
            src_offset += num_comps;
            dest_offset += 3 + alpha01;
        }
        Ok(())
    }

    /// `getRgbBuffer`: `count` colours of `bits`-bit components (`src` holds the integer components) into `dest`,
    /// `3 + alpha01` bytes apart.
    #[allow(clippy::too_many_arguments)]
    pub fn get_rgb_buffer<T: Copy + Into<f64>>(
        &self,
        src: &[T],
        src_offset: usize,
        count: usize,
        dest: &mut [u8],
        dest_offset: usize,
        bits: u32,
        alpha01: usize,
    ) -> Result<()> {
        let max_value = ((1u64 << bits.min(31)) - 1) as f64;
        let scale = 1.0 / max_value;
        match &self.kind {
            Kind::Gray => {
                let scale = 255.0 / max_value;
                let (mut j, mut q) = (src_offset, dest_offset);
                for _ in 0..count {
                    let c = scale * load(src, j);
                    j += 1;
                    for k in 0..3 {
                        store(dest, q + k, c);
                    }
                    q += 3 + alpha01;
                }
            }
            Kind::Rgb => {
                if bits == 8 && alpha01 == 0 {
                    for n in 0..count * 3 {
                        store(dest, dest_offset + n, load(src, src_offset + n));
                    }
                    return Ok(());
                }
                let scale = 255.0 / max_value;
                let (mut j, mut q) = (src_offset, dest_offset);
                for _ in 0..count {
                    for k in 0..3 {
                        store(dest, q + k, scale * load(src, j + k));
                    }
                    j += 3;
                    q += 3 + alpha01;
                }
            }
            Kind::Rgba | Kind::Pattern(_) => {
                return Err(format_error("Should not call ColorSpace.getRgbBuffer"));
            }
            Kind::Cmyk => {
                let (mut s, mut d) = (src_offset, dest_offset);
                for _ in 0..count {
                    let rgb = cmyk_to_rgb(
                        load(src, s) * scale,
                        load(src, s + 1) * scale,
                        load(src, s + 2) * scale,
                        load(src, s + 3) * scale,
                    );
                    store_rgb(dest, d, rgb);
                    s += 4;
                    d += 3 + alpha01;
                }
            }
            Kind::CalGray(c) => {
                let (mut s, mut d) = (src_offset, dest_offset);
                for _ in 0..count {
                    let val = c.to_rgb(load(src, s), scale);
                    for k in 0..3 {
                        store(dest, d + k, val);
                    }
                    s += 1;
                    d += 3 + alpha01;
                }
            }
            Kind::CalRgb(c) => {
                let (mut s, mut d) = (src_offset, dest_offset);
                for _ in 0..count {
                    let rgb = c.to_rgb(load(src, s), load(src, s + 1), load(src, s + 2), scale);
                    store_rgb(dest, d, rgb);
                    s += 3;
                    d += 3 + alpha01;
                }
            }
            Kind::Lab(l) => {
                let (mut s, mut d) = (src_offset, dest_offset);
                for _ in 0..count {
                    let rgb = l.to_rgb(
                        load(src, s),
                        load(src, s + 1),
                        load(src, s + 2),
                        Some(max_value),
                    );
                    store_rgb(dest, d, rgb);
                    s += 3;
                    d += 3 + alpha01;
                }
            }
            Kind::Indexed(i) => {
                let (mut s, mut d) = (src_offset, dest_offset);
                for _ in 0..count {
                    let pos = indexed_position(load(src, s), i.high_val);
                    s += 1;
                    for k in 0..3 {
                        store(
                            dest,
                            d + k,
                            pos.map_or(f64::NAN, |p| f64::from(i.rgb_lookup[p + k])),
                        );
                    }
                    d += 3 + alpha01;
                }
            }
            Kind::Alternate(a) => {
                return alternate_rgb_buffer(
                    a,
                    src,
                    src_offset,
                    count,
                    dest,
                    dest_offset,
                    alpha01,
                    scale,
                );
            }
        }
        Ok(())
    }

    /// `fillRgb`: the colours of an image's components (`comps`, `bpc` bits each) as RGB(A) bytes in `dest`, resized
    /// from `original_width x original_height` to `width x height` when they differ.
    #[allow(clippy::too_many_arguments)]
    pub fn fill_rgb<T: Copy + Into<f64> + Into<u32>>(
        &self,
        dest: &mut [u8],
        original_width: usize,
        original_height: usize,
        width: usize,
        height: usize,
        actual_height: usize,
        bpc: u32,
        comps: &[T],
        alpha01: usize,
    ) -> Result<()> {
        if matches!(self.kind, Kind::Rgba) {
            if original_height != height || original_width != width {
                resize_rgba_image(
                    &to_bytes(comps),
                    dest,
                    original_width,
                    original_height,
                    width,
                    height,
                    alpha01,
                );
            } else {
                copy_rgba_image(&to_bytes(comps), dest, alpha01);
            }
            return Ok(());
        }
        let count = original_width * original_height;
        let mut rgb_buf: Option<Vec<u8>> = None;
        let number_of_colors = 1usize << bpc;
        let needs_resizing = original_height != height || original_width != width;
        if self.is_passthrough(bpc) {
            rgb_buf = Some(to_bytes(comps));
        } else if self.num_comps() == 1
            && count > number_of_colors
            && self.name() != "DeviceGray"
            && self.name() != "DeviceRGB"
        {
            let all_colors: Vec<u32> = (0..number_of_colors as u32).collect();
            let mut color_map = vec![0u8; number_of_colors * 3];
            self.get_rgb_buffer(&all_colors, 0, number_of_colors, &mut color_map, 0, bpc, 0)?;
            if !needs_resizing {
                let mut dest_pos = 0;
                for i in 0..count {
                    let key = comps
                        .get(i)
                        .map_or(usize::MAX, |v| <T as Into<u32>>::into(*v) as usize * 3);
                    for k in 0..3 {
                        let value = color_map.get(key.wrapping_add(k)).copied().unwrap_or(0);
                        if let Some(slot) = dest.get_mut(dest_pos) {
                            *slot = value;
                        }
                        dest_pos += 1;
                    }
                    dest_pos += alpha01;
                }
            } else {
                let mut buffer = vec![0u8; count * 3];
                for i in 0..count {
                    let key = comps
                        .get(i)
                        .map_or(usize::MAX, |v| <T as Into<u32>>::into(*v) as usize * 3);
                    for k in 0..3 {
                        buffer[i * 3 + k] =
                            color_map.get(key.wrapping_add(k)).copied().unwrap_or(0);
                    }
                }
                rgb_buf = Some(buffer);
            }
        } else if !needs_resizing {
            self.get_rgb_buffer(comps, 0, width * actual_height, dest, 0, bpc, alpha01)?;
        } else {
            let mut buffer = vec![0u8; count * 3];
            self.get_rgb_buffer(comps, 0, count, &mut buffer, 0, bpc, 0)?;
            rgb_buf = Some(buffer);
        }
        if let Some(rgb_buf) = rgb_buf {
            if needs_resizing {
                resize_rgb_image(
                    &rgb_buf,
                    dest,
                    original_width,
                    original_height,
                    width,
                    height,
                    alpha01,
                );
            } else {
                let (mut dest_pos, mut rgb_pos) = (0usize, 0usize);
                for _ in 0..width * actual_height {
                    for _ in 0..3 {
                        if let Some(slot) = dest.get_mut(dest_pos) {
                            *slot = rgb_buf.get(rgb_pos).copied().unwrap_or(0);
                        }
                        dest_pos += 1;
                        rgb_pos += 1;
                    }
                    dest_pos += alpha01;
                }
            }
        }
        Ok(())
    }
}

fn to_bytes<T: Copy + Into<f64>>(comps: &[T]) -> Vec<u8> {
    comps.iter().map(|v| to_u8_clamped((*v).into())).collect()
}

fn store_rgb(dest: &mut [u8], at: usize, rgb: [f64; 3]) {
    for (k, v) in rgb.iter().enumerate() {
        store(dest, at + k, *v);
    }
}

fn round_to_f32(values: &mut [f64]) {
    for v in values {
        *v = float32(*v);
    }
}

/// `MathClamp(Math.round(v), 0, highVal) * 3`; `None` when that is `NaN` (the lookup then reads `undefined`).
fn indexed_position(v: f64, high_val: f64) -> Option<usize> {
    let clamped = clamp(js::round(v), 0.0, high_val);
    if clamped.is_nan() {
        None
    } else {
        Some(clamped as usize * 3)
    }
}

/// `ColorSpace.isDefaultDecode`.
fn is_default_decode(decode: Option<&[f64]>, num_comps: usize) -> bool {
    if is_default_decode_helper(decode, num_comps * 2) {
        return true;
    }
    let decode = decode.unwrap_or(&[]);
    decode[..num_comps * 2]
        .chunks(2)
        .all(|pair| pair[0] == 0.0 && pair[1] == 1.0)
}

/// `AlternateCS.getRgbBuffer`.
#[allow(clippy::too_many_arguments)]
fn alternate_rgb_buffer<T: Copy + Into<f64>>(
    a: &Alternate,
    src: &[T],
    src_offset: usize,
    count: usize,
    dest: &mut [u8],
    dest_offset: usize,
    alpha01: usize,
    scale: f64,
) -> Result<()> {
    let base = &a.base;
    let base_num = base.num_comps();
    let uses_zero_to_one = base.uses_zero_to_one_range();
    let passthrough = (base.is_passthrough(8) || !uses_zero_to_one) && alpha01 == 0;
    let num_comps = a.num_comps;
    let mut scaled = vec![0.0f64; num_comps];
    let mut tinted = vec![0.0f64; base_num.max(a.tint.num_outputs())];
    let mut staging: Vec<u8> = if passthrough {
        Vec::new()
    } else {
        vec![0u8; base_num * count]
    };
    let mut pos = if passthrough { dest_offset } else { 0 };
    let mut src_offset = src_offset;
    for _ in 0..count {
        for slot in scaled.iter_mut() {
            *slot = float32(load(src, src_offset) * scale);
            src_offset += 1;
        }
        a.tint.call(&scaled, &mut tinted)?;
        round_to_f32(&mut tinted);
        let target: &mut [u8] = if passthrough {
            &mut *dest
        } else {
            &mut staging
        };
        if uses_zero_to_one {
            for value in tinted.iter().take(base_num) {
                store(target, pos, value * 255.0);
                pos += 1;
            }
        } else {
            base.get_rgb_item(&tinted, 0, target, pos)?;
            pos += base_num;
        }
    }
    if !passthrough {
        base.get_rgb_buffer(&staging, 0, count, dest, dest_offset, 8, alpha01)?;
    }
    Ok(())
}

// ---- image resizers ------------------------------------------------------------------------------------------------

fn wrap_u16(x: f64) -> usize {
    ((x as u64) & 0xffff) as usize
}

/// `resizeRgbImage`.
fn resize_rgb_image(
    src: &[u8],
    dest: &mut [u8],
    w1: usize,
    h1: usize,
    w2: usize,
    h2: usize,
    alpha01: usize,
) {
    let alpha01 = if alpha01 != 1 { 0 } else { alpha01 };
    let x_ratio = w1 as f64 / w2 as f64;
    let y_ratio = h1 as f64 / h2 as f64;
    let x_scaled: Vec<usize> = (0..w2)
        .map(|i| wrap_u16((i as f64 * x_ratio).floor() * 3.0))
        .collect();
    let w1_scanline = w1 * 3;
    let mut new_index = 0usize;
    for i in 0..h2 {
        let py = (i as f64 * y_ratio).floor() as usize * w1_scanline;
        for x in x_scaled.iter().take(w2) {
            for k in 0..3 {
                if let Some(slot) = dest.get_mut(new_index) {
                    *slot = src.get(py + x + k).copied().unwrap_or(0);
                }
                new_index += 1;
            }
            new_index += alpha01;
        }
    }
}

/// `resizeRgbaImage`.
fn resize_rgba_image(
    src: &[u8],
    dest: &mut [u8],
    w1: usize,
    h1: usize,
    w2: usize,
    h2: usize,
    alpha01: usize,
) {
    let x_ratio = w1 as f64 / w2 as f64;
    let y_ratio = h1 as f64 / h2 as f64;
    let mut new_index = 0usize;
    if alpha01 == 1 {
        let x_scaled: Vec<usize> = (0..w2)
            .map(|i| wrap_u16((i as f64 * x_ratio).floor()))
            .collect();
        for i in 0..h2 {
            let row = (i as f64 * y_ratio).floor() as usize * w1;
            for x in x_scaled.iter().take(w2) {
                let from = (row + x) * 4;
                for k in 0..3 {
                    if let (Some(slot), Some(value)) =
                        (dest.get_mut(new_index * 4 + k), src.get(from + k))
                    {
                        *slot |= *value;
                    }
                }
                new_index += 1;
            }
        }
    } else {
        let w1_scanline = w1 * 4;
        let x_scaled: Vec<usize> = (0..w2)
            .map(|i| wrap_u16((i as f64 * x_ratio).floor() * 4.0))
            .collect();
        for i in 0..h2 {
            let row = (i as f64 * y_ratio).floor() as usize * w1_scanline;
            for x in x_scaled.iter().take(w2) {
                let old_index = row + x;
                for k in 0..3 {
                    if let Some(slot) = dest.get_mut(new_index) {
                        *slot = src.get(old_index + k).copied().unwrap_or(0);
                    }
                    new_index += 1;
                }
            }
        }
    }
}

/// `copyRgbaImage`.
fn copy_rgba_image(src: &[u8], dest: &mut [u8], alpha01: usize) {
    if alpha01 == 1 {
        for (pixel, out) in src.chunks_exact(4).zip(dest.chunks_exact_mut(4)) {
            for k in 0..3 {
                out[k] |= pixel[k];
            }
        }
    } else {
        let mut j = 0;
        for pixel in src.chunks(4) {
            for k in 0..3 {
                if let Some(slot) = dest.get_mut(j) {
                    *slot = pixel.get(k).copied().unwrap_or(0);
                }
                j += 1;
            }
        }
    }
}

// ---- parsing (`ColorSpaceUtils.parse`) -----------------------------------------------------------------------------

/// `ColorSpaceUtils.parse`: the colour space `cs` (a reference, a name or an array) names. `resources` is the
/// dictionary a name is looked up in (`/ColorSpace`).
pub fn parse(cs: &Obj, xref: &Xref, resources: Option<&Dict>) -> Result<Arc<ColorSpace>> {
    let fetched = xref.fetch_if_ref(cs, false)?;
    parse_object(&fetched, xref, resources, 0)
}

/// `#subParse`: like `parse_object` of a reference's target.
fn sub_parse(
    cs: &Obj,
    xref: &Xref,
    resources: Option<&Dict>,
    depth: usize,
) -> Result<Arc<ColorSpace>> {
    parse_object(cs, xref, resources, depth + 1)
}

fn truthy(obj: &Obj) -> bool {
    match obj {
        Obj::Null => false,
        Obj::Bool(b) => *b,
        Obj::Num(n) => *n != 0.0 && !n.is_nan(),
        _ => true,
    }
}

/// `elements as numbers`, a missing or non-number one as `NaN` (what destructuring reads as `undefined`).
fn white_black_array(xref: &Xref, params: &Dict, key: &str) -> Result<Option<Vec<f64>>> {
    match xref.get_array(params, key)? {
        Obj::Array(items) => Ok(Some(
            items
                .iter()
                .map(|o| o.as_num().unwrap_or(f64::NAN))
                .collect(),
        )),
        Obj::Null => Ok(None),
        other if !truthy(&other) => Ok(None),
        _ => Err(format_error("colour space parameter is not iterable")),
    }
}

fn nth(list: &[f64], i: usize) -> f64 {
    list.get(i).copied().unwrap_or(f64::NAN)
}

fn params_dict(xref: &Xref, element: Option<&Obj>) -> Result<Arc<Dict>> {
    let fetched = match element {
        Some(obj) => xref.fetch_if_ref(obj, false)?,
        None => Obj::Null,
    };
    match fetched {
        Obj::Dict(dict) => Ok(dict),
        _ => Err(format_error("colour space parameters are not a dictionary")),
    }
}

fn parse_cal_gray(xref: &Xref, params: &Dict) -> Result<ColorSpace> {
    let white = white_black_array(xref, params, "WhitePoint")?
        .ok_or_else(|| format_error("WhitePoint missing - required for color space CalGray"))?;
    let black = white_black_array(xref, params, "BlackPoint")?;
    let gamma = xref.get(params, "Gamma")?.as_num();
    let (xw, yw, zw) = (nth(&white, 0), nth(&white, 1), nth(&white, 2));
    let (mut xb, mut yb, mut zb) = black
        .as_ref()
        .map_or((0.0, 0.0, 0.0), |b| (nth(b, 0), nth(b, 1), nth(b, 2)));
    let mut g = match gamma {
        Some(g) if g != 0.0 && !g.is_nan() => g,
        _ => 1.0,
    };
    if xw < 0.0 || zw < 0.0 || yw != 1.0 {
        return Err(format_error(
            "Invalid WhitePoint components for CalGray, no fallback available",
        ));
    }
    if xb < 0.0 || yb < 0.0 || zb < 0.0 {
        tracing::debug!("Invalid BlackPoint for CalGray, falling back to default.");
        xb = 0.0;
        yb = 0.0;
        zb = 0.0;
    }
    if xb != 0.0 || yb != 0.0 || zb != 0.0 {
        tracing::debug!("CalGray, BlackPoint: only default values are supported.");
    }
    if g < 1.0 {
        tracing::debug!("Invalid Gamma: {g} for CalGray, falling back to default.");
        g = 1.0;
    }
    Ok(ColorSpace {
        kind: Kind::CalGray(CalGray { yw, gamma: g }),
    })
}

fn parse_cal_rgb(xref: &Xref, params: &Dict) -> Result<ColorSpace> {
    let white = white_black_array(xref, params, "WhitePoint")?
        .ok_or_else(|| format_error("WhitePoint missing - required for color space CalRGB"))?;
    let black = white_black_array(xref, params, "BlackPoint")?;
    let gamma = white_black_array(xref, params, "Gamma")?;
    let matrix = white_black_array(xref, params, "Matrix")?;
    let white_point = [nth(&white, 0), nth(&white, 1), nth(&white, 2)];
    let mut black_point = black
        .as_ref()
        .map_or([0.0; 3], |b| [nth(b, 0), nth(b, 1), nth(b, 2)]);
    let mut gamma = gamma
        .as_ref()
        .map_or([1.0; 3], |g| [nth(g, 0), nth(g, 1), nth(g, 2)]);
    let matrix = matrix
        .as_ref()
        .map_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], |m| {
            std::array::from_fn(|i| nth(m, i))
        });
    if white_point[0] < 0.0 || white_point[2] < 0.0 || white_point[1] != 1.0 {
        return Err(format_error(
            "Invalid WhitePoint components for CalRGB, no fallback available",
        ));
    }
    if black_point.iter().any(|v| *v < 0.0) {
        tracing::debug!("Invalid BlackPoint for CalRGB, falling back to default.");
        black_point = [0.0; 3];
    }
    if gamma.iter().any(|v| *v < 0.0) {
        tracing::debug!("Invalid Gamma for CalRGB, falling back to default.");
        gamma = [1.0; 3];
    }
    Ok(ColorSpace {
        kind: Kind::CalRgb(CalRgb {
            white_point,
            black_point,
            gamma,
            matrix,
        }),
    })
}

fn parse_lab(xref: &Xref, params: &Dict) -> Result<ColorSpace> {
    let white = white_black_array(xref, params, "WhitePoint")?
        .ok_or_else(|| format_error("WhitePoint missing - required for color space Lab"))?;
    let black = white_black_array(xref, params, "BlackPoint")?;
    let range = white_black_array(xref, params, "Range")?;
    let (xw, yw, zw) = (nth(&white, 0), nth(&white, 1), nth(&white, 2));
    let (mut amin, mut amax, mut bmin, mut bmax) =
        range.as_ref().map_or((-100.0, 100.0, -100.0, 100.0), |r| {
            (nth(r, 0), nth(r, 1), nth(r, 2), nth(r, 3))
        });
    let (xb, yb, zb) = black
        .as_ref()
        .map_or((0.0, 0.0, 0.0), |b| (nth(b, 0), nth(b, 1), nth(b, 2)));
    if xw < 0.0 || zw < 0.0 || yw != 1.0 {
        return Err(format_error(
            "Invalid WhitePoint components, no fallback available",
        ));
    }
    if xb < 0.0 || yb < 0.0 || zb < 0.0 {
        tracing::debug!("Invalid BlackPoint, falling back to default");
    }
    if amin > amax || bmin > bmax {
        tracing::debug!("Invalid Range, falling back to defaults");
        amin = -100.0;
        amax = 100.0;
        bmin = -100.0;
        bmax = 100.0;
    }
    Ok(ColorSpace {
        kind: Kind::Lab(Lab {
            xw,
            yw,
            zw,
            amin,
            amax,
            bmin,
            bmax,
        }),
    })
}

fn parse_indexed(
    cs: &[Obj],
    xref: &Xref,
    resources: Option<&Dict>,
    depth: usize,
) -> Result<ColorSpace> {
    let base_obj = cs
        .get(1)
        .ok_or_else(|| format_error("Indexed colour space without a base"))?;
    let base = sub_parse(base_obj, xref, resources, depth)?;
    let high = match cs.get(2) {
        Some(obj) => xref.fetch_if_ref(obj, false)?,
        None => Obj::Null,
    };
    let high_val = clamp(high.as_num().unwrap_or(f64::NAN), 0.0, 255.0);
    if high_val.is_nan() {
        return Err(format_error(
            "IndexedCS - the highest index is not a number",
        ));
    }
    let high_val = high_val.floor();
    let lookup = match cs.get(3) {
        Some(obj) => xref.fetch_if_ref(obj, false)?,
        None => Obj::Null,
    };
    let count = high_val as usize + 1;
    let length = base.num_comps() * count;
    let mut palette = vec![0u8; length];
    match &lookup {
        Obj::Stream(stream) => {
            let bytes = stream.decode(&**xref.filters(), xref.guard())?;
            let n = bytes.len().min(length);
            palette[..n].copy_from_slice(&bytes[..n]);
        }
        Obj::Str(bytes) => {
            let n = bytes.len().min(length);
            palette[..n].copy_from_slice(&bytes[..n]);
        }
        _ => return Err(format_error("IndexedCS - unrecognized lookup table")),
    }
    let mut rgb_lookup = vec![0u8; count * 3];
    base.get_rgb_buffer(&palette, 0, count, &mut rgb_lookup, 0, 8, 0)?;
    Ok(ColorSpace {
        kind: Kind::Indexed(Indexed {
            high_val,
            rgb_lookup,
        }),
    })
}

/// `ICCBased` without qcms.
fn parse_icc_based(
    cs: &[Obj],
    xref: &Xref,
    resources: Option<&Dict>,
    depth: usize,
) -> Result<Option<Arc<ColorSpace>>> {
    let element = cs
        .get(1)
        .ok_or_else(|| format_error("ICCBased colour space without a stream"))?;
    let stream = xref.fetch_if_ref(element, false)?;
    let Some(dict) = stream.as_stream().map(|s| s.dict.clone()) else {
        return Err(format_error("ICCBased colour space is not a stream"));
    };
    let num_comps = xref.get(&dict, "N")?.as_num();
    if let Some(alternate) = dict.get_raw("Alternate")
        && truthy(alternate)
    {
        let alt = sub_parse(alternate, xref, resources, depth)?;
        if num_comps == Some(alt.num_comps() as f64) {
            return Ok(Some(alt));
        }
        tracing::debug!("ICCBased color space: Ignoring incorrect /Alternate entry.");
    }
    Ok(match num_comps {
        Some(1.0) => Some(gray_space()),
        Some(3.0) => Some(rgb_space()),
        Some(4.0) => Some(cmyk_space()),
        _ => None,
    })
}

fn parse_array(
    cs: &[Obj],
    xref: &Xref,
    resources: Option<&Dict>,
    depth: usize,
) -> Result<Arc<ColorSpace>> {
    let first = cs
        .first()
        .ok_or_else(|| format_error("Empty colour space array"))?;
    let mode = xref.fetch_if_ref(first, false)?;
    let Some(mode) = mode.as_name() else {
        tracing::debug!("Unimplemented ColorSpace object");
        return Ok(gray_space());
    };
    match mode {
        "G" | "DeviceGray" => Ok(gray_space()),
        "RGB" | "DeviceRGB" => Ok(rgb_space()),
        "CMYK" | "DeviceCMYK" => Ok(cmyk_space()),
        "CalGray" => {
            let params = params_dict(xref, cs.get(1))?;
            Ok(Arc::new(parse_cal_gray(xref, &params)?))
        }
        "CalRGB" => {
            let params = params_dict(xref, cs.get(1))?;
            Ok(Arc::new(parse_cal_rgb(xref, &params)?))
        }
        "ICCBased" => match parse_icc_based(cs, xref, resources, depth)? {
            Some(space) => Ok(space),
            None => {
                tracing::debug!("Unrecognized ColorSpace object");
                Ok(gray_space())
            }
        },
        "Pattern" => {
            let base = match cs.get(1) {
                Some(obj) if truthy(obj) => Some(sub_parse(obj, xref, resources, depth)?),
                _ => None,
            };
            Ok(Arc::new(ColorSpace {
                kind: Kind::Pattern(base),
            }))
        }
        "I" | "Indexed" => Ok(Arc::new(parse_indexed(cs, xref, resources, depth)?)),
        "Separation" | "DeviceN" => {
            let name = match cs.get(1) {
                Some(obj) => xref.fetch_if_ref(obj, false)?,
                None => Obj::Null,
            };
            let num_comps = name.as_array().map_or(1, |names| names.len());
            let base_obj = cs
                .get(2)
                .ok_or_else(|| format_error("Alternate colour space missing"))?;
            let base = sub_parse(base_obj, xref, resources, depth)?;
            let function_obj = cs
                .get(3)
                .ok_or_else(|| format_error("Tint transform missing"))?;
            let tint = function::create(xref, function_obj, false)?;
            Ok(Arc::new(ColorSpace {
                kind: Kind::Alternate(Alternate {
                    num_comps,
                    base,
                    tint,
                }),
            }))
        }
        "Lab" => {
            let params = params_dict(xref, cs.get(1))?;
            Ok(Arc::new(parse_lab(xref, &params)?))
        }
        _ => {
            tracing::debug!("Unimplemented ColorSpace object: {mode}");
            Ok(gray_space())
        }
    }
}

/// `#parse` of an already fetched object.
fn parse_object(
    cs: &Obj,
    xref: &Xref,
    resources: Option<&Dict>,
    depth: usize,
) -> Result<Arc<ColorSpace>> {
    if depth > MAX_DEPTH {
        return Err(format_error("Colour spaces nested too deeply."));
    }
    let cs = xref.fetch_if_ref(cs, false)?;
    let name = cs.as_name().map(str::to_owned);
    let cs = match name {
        Some(name) => match name.as_str() {
            "G" | "DeviceGray" => return Ok(gray_space()),
            "RGB" | "DeviceRGB" => return Ok(rgb_space()),
            "DeviceRGBA" => return Ok(rgba_space()),
            "CMYK" | "DeviceCMYK" => return Ok(cmyk_space()),
            "Pattern" => {
                return Ok(Arc::new(ColorSpace {
                    kind: Kind::Pattern(None),
                }));
            }
            other => {
                let mut found = None;
                if let Some(resources) = resources
                    && let Obj::Dict(color_spaces) = xref.get(resources, "ColorSpace")?
                {
                    let entry = xref.get(&color_spaces, other)?;
                    if truthy(&entry) {
                        found = Some(entry);
                    }
                }
                match found {
                    Some(entry @ Obj::Name(_)) => {
                        return parse_object(&entry, xref, resources, depth + 1);
                    }
                    Some(entry) => entry,
                    None => {
                        tracing::debug!("Unrecognized ColorSpace: {other}");
                        return Ok(gray_space());
                    }
                }
            }
        },
        None => cs,
    };
    match &cs {
        Obj::Array(items) => parse_array(items, xref, resources, depth),
        _ => {
            tracing::debug!("Unrecognized ColorSpace object");
            Ok(gray_space())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(space: &ColorSpace, comps: &[f64]) -> [u8; 3] {
        space.get_rgb(comps, 0).expect("converts")
    }

    #[test]
    fn typed_array_clamping_rounds_half_to_even() {
        assert_eq!(to_u8_clamped(0.5), 0);
        assert_eq!(to_u8_clamped(1.5), 2);
        assert_eq!(to_u8_clamped(2.5), 2);
        assert_eq!(to_u8_clamped(254.5), 254);
        assert_eq!(to_u8_clamped(255.4), 255);
        assert_eq!(to_u8_clamped(-3.0), 0);
        assert_eq!(to_u8_clamped(f64::NAN), 0);
        assert_eq!(to_u8_clamped(127.5000001), 128);
    }

    #[test]
    fn device_gray_and_rgb() {
        assert_eq!(rgb(&ColorSpace::gray(), &[0.5]), [128, 128, 128]);
        assert_eq!(rgb(&ColorSpace::gray(), &[2.0]), [255, 255, 255]);
        assert_eq!(rgb(&ColorSpace::rgb(), &[1.0, 0.5, 0.0]), [255, 128, 0]);
        assert_eq!(
            ColorSpace::rgb()
                .get_rgb_hex(&[1.0, 0.0, 0.5], 0)
                .expect("hex"),
            "#ff0080"
        );
    }

    #[test]
    fn device_cmyk_polynomial() {
        let cmyk = ColorSpace::cmyk();
        assert_eq!(rgb(&cmyk, &[0.0, 0.0, 0.0, 0.0]), [255, 255, 255]);
        assert_eq!(rgb(&cmyk, &[0.0, 0.0, 0.0, 1.0]), [44, 46, 53]);
        assert_eq!(rgb(&cmyk, &[1.0, 0.0, 0.0, 0.0]), [0, 185, 242]);
    }

    #[test]
    fn rgb_buffer_passthrough_and_scaling() {
        let rgb = ColorSpace::rgb();
        let mut dest = [0u8; 6];
        rgb.get_rgb_buffer(&[10u8, 20, 30, 40, 50, 60], 0, 2, &mut dest, 0, 8, 0)
            .expect("converts");
        assert_eq!(dest, [10, 20, 30, 40, 50, 60]);
        let mut with_alpha = [9u8; 8];
        rgb.get_rgb_buffer(&[15u8, 0, 7], 0, 1, &mut with_alpha, 0, 4, 1)
            .expect("converts");
        assert_eq!(with_alpha, [255, 0, 119, 9, 9, 9, 9, 9]);
    }

    #[test]
    fn gray_buffer_scales_by_bit_depth() {
        let gray = ColorSpace::gray();
        let mut dest = [0u8; 6];
        gray.get_rgb_buffer(&[1u8, 0], 0, 2, &mut dest, 0, 1, 0)
            .expect("converts");
        assert_eq!(dest, [255, 255, 255, 0, 0, 0]);
    }

    #[test]
    fn rgba_has_no_per_colour_conversion() {
        let rgba = ColorSpace::rgba();
        assert!(rgba.get_rgb(&[0.0; 4], 0).is_err());
        assert!(rgba.is_passthrough(8));
        assert_eq!(rgba.num_comps(), 4);
    }

    #[test]
    fn pattern_has_no_components_and_no_decode() {
        let pattern = ColorSpace {
            kind: Kind::Pattern(None),
        };
        assert_eq!(pattern.name(), "Pattern");
        assert_eq!(pattern.num_comps(), 0);
        assert!(pattern.is_default_decode(None, 8.0).is_err());
        assert!(pattern.get_rgb(&[0.0], 0).is_err());
    }

    #[test]
    fn lab_white_and_black() {
        let lab = ColorSpace {
            kind: Kind::Lab(Lab {
                xw: 0.9642,
                yw: 1.0,
                zw: 0.8249,
                amin: -128.0,
                amax: 127.0,
                bmin: -128.0,
                bmax: 127.0,
            }),
        };
        assert_eq!(rgb(&lab, &[0.0, 0.0, 0.0]), [0, 0, 0]);
        let white = rgb(&lab, &[100.0, 0.0, 0.0]);
        assert_eq!(white[0], 255);
        assert!(!lab.uses_zero_to_one_range());
        assert!(lab.is_default_decode(Some(&[5.0]), 8.0).expect("decode"));
    }

    #[test]
    fn cal_gray_is_neutral() {
        let cal = ColorSpace {
            kind: Kind::CalGray(CalGray {
                yw: 1.0,
                gamma: 2.2,
            }),
        };
        let mid = rgb(&cal, &[0.5]);
        assert_eq!(mid[0], mid[1]);
        assert_eq!(mid[1], mid[2]);
        assert_eq!(rgb(&cal, &[0.0]), [0, 0, 0]);
        assert_eq!(rgb(&cal, &[1.0]), [255, 255, 255]);
    }

    #[test]
    fn cal_rgb_white_point_of_one_maps_white_to_white() {
        let cal = ColorSpace {
            kind: Kind::CalRgb(CalRgb {
                white_point: [0.9505, 1.0, 1.089],
                black_point: [0.0; 3],
                gamma: [2.2; 3],
                matrix: [
                    0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505,
                ],
            }),
        };
        let white = rgb(&cal, &[1.0, 1.0, 1.0]);
        assert!(white.iter().all(|v| *v >= 250));
        assert_eq!(rgb(&cal, &[0.0, 0.0, 0.0]), [0, 0, 0]);
    }

    fn indexed() -> ColorSpace {
        ColorSpace {
            kind: Kind::Indexed(Indexed {
                high_val: 2.0,
                rgb_lookup: vec![10, 11, 12, 20, 21, 22, 30, 31, 32],
            }),
        }
    }

    #[test]
    fn indexed_rounds_and_clamps_the_index() {
        let space = indexed();
        assert_eq!(rgb(&space, &[0.0]), [10, 11, 12]);
        assert_eq!(rgb(&space, &[1.5]), [30, 31, 32]);
        assert_eq!(rgb(&space, &[0.49]), [10, 11, 12]);
        assert_eq!(rgb(&space, &[-4.0]), [10, 11, 12]);
        assert_eq!(rgb(&space, &[99.0]), [30, 31, 32]);
        assert_eq!(rgb(&space, &[f64::NAN]), [0, 0, 0]);
        assert!(
            space
                .is_default_decode(Some(&[0.0, 255.0]), 8.0)
                .expect("decode")
        );
        assert!(
            !space
                .is_default_decode(Some(&[0.0, 1.0]), 8.0)
                .expect("decode")
        );
    }

    #[test]
    fn get_rgb_items_steps_by_the_destination_stride() {
        let gray = ColorSpace::gray();
        let mut dest = [7u8; 8];
        gray.get_rgb_items(&[0.0, 1.0], 2, &mut dest, 0, 1)
            .expect("converts");
        assert_eq!(dest, [0, 0, 0, 7, 255, 255, 255, 7]);
    }

    #[test]
    fn default_decode_checks_the_pairs() {
        let gray = ColorSpace::gray();
        assert!(gray.is_default_decode(None, 8.0).expect("decode"));
        assert!(
            gray.is_default_decode(Some(&[0.0, 1.0]), 8.0)
                .expect("decode")
        );
        assert!(
            !gray
                .is_default_decode(Some(&[1.0, 0.0]), 8.0)
                .expect("decode")
        );
        assert!(gray.is_default_decode(Some(&[1.0]), 8.0).expect("decode"));
    }

    #[test]
    fn fill_rgb_of_an_indexed_image_goes_through_a_colour_map() {
        let space = indexed();
        let comps: Vec<u8> = vec![0, 1, 2, 2, 1, 0];
        let mut dest = vec![0u8; 6 * 3];
        space
            .fill_rgb(&mut dest, 3, 2, 3, 2, 2, 2, &comps, 0)
            .expect("fills");
        assert_eq!(&dest[..9], &[10, 11, 12, 20, 21, 22, 30, 31, 32]);
        assert_eq!(&dest[9..], &[30, 31, 32, 20, 21, 22, 10, 11, 12]);
    }

    #[test]
    fn fill_rgb_resizes_by_nearest_neighbour() {
        let rgb = ColorSpace::rgb();
        let comps: Vec<u8> = vec![1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4];
        let mut dest = vec![0u8; 3 * 2];
        // a 2x2 image shown as 2x1: the first row's two pixels... the second output row does not exist
        rgb.fill_rgb(&mut dest, 2, 2, 2, 1, 1, 8, &comps, 0)
            .expect("fills");
        assert_eq!(dest, vec![1, 1, 1, 2, 2, 2]);
    }
}
