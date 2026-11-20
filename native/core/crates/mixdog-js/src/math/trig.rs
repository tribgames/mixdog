// Adapted from Node v22.20.0 deps/v8/src/base/ieee754.cc.
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// Modified significantly by Google Inc. Copyright 2016 the V8 project authors.
// V8's BSD license is preserved in reference/LICENSE.v8.
//! V8's fdlibm sin/cos/tan kernels and quadrant dispatch. No platform libm trig.
#![allow(clippy::excessive_precision, clippy::approx_constant, clippy::eq_op)]
use super::reduction::rem_pio2;
use super::{abs, high, low, quiet_nan, with_low_zero, words};

fn kernel_sin(x: f64, y: f64, tail: bool) -> f64 {
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    if high(x) & 0x7fff_ffff < 0x3e40_0000 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if !tail { x + v * (S1 + z * r) } else { x - ((z * (0.5 * y - v * r) - y) - v * S1) }
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let ix = high(x) & 0x7fff_ffff;
    if ix < 0x3e40_0000 {
        return 1.0;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3fd3_3333 {
        1.0 - (0.5 * z - (z * r - x * y))
    } else {
        let qx = if ix > 0x3fe9_0000 { 0.28125 } else { words(ix - 0x0020_0000, 0) };
        let iz = 0.5 * z - qx;
        let a = 1.0 - qx;
        a - (iz - (z * r - x * y))
    }
}

fn kernel_tan(mut x: f64, mut y: f64, iy: i32) -> f64 {
    const T: [f64; 13] = [
        3.33333333333334091986e-01,
        1.33333333333201242699e-01,
        5.39682539762260521377e-02,
        2.18694882948595424599e-02,
        8.86323982359930005737e-03,
        3.59207910759131235356e-03,
        1.45620945432529025516e-03,
        5.88041240820264096874e-04,
        2.46463134818469906812e-04,
        7.81794442939557092300e-05,
        7.14072491382608190305e-05,
        -1.85586374855275456654e-05,
        2.59073051863633712884e-05,
    ];
    const PIO4: f64 = 7.85398163397448278999e-01;
    const PIO4LO: f64 = 3.06161699786838301793e-17;
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix < 0x3e30_0000 {
        if ((ix as u32 | low(x)) | (iy + 1) as u32) == 0 {
            return 1.0 / abs(x);
        }
        if iy == 1 {
            return x;
        }
        let w = x + y;
        let z = with_low_zero(w);
        let v = y - (z - x);
        let a = -1.0 / w;
        let t = with_low_zero(a);
        let s = 1.0 + t * z;
        return t + a * (s + t * v);
    }
    if ix >= 0x3fe5_9428 {
        if hx < 0 {
            x = -x;
            y = -y
        }
        let z = PIO4 - x;
        let w = PIO4LO - y;
        x = z + w;
        y = 0.0
    }
    let z = x * x;
    let w = z * z;
    let mut r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    let s = z * x;
    r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    let w = x + r;
    if ix >= 0x3fe5_9428 {
        let v = f64::from(iy);
        return f64::from(1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if iy == 1 {
        return w;
    }
    let z = with_low_zero(w);
    let v = r - (z - x);
    let a = -1.0 / w;
    let t = with_low_zero(a);
    let s = 1.0 + t * z;
    t + a * (s + t * v)
}

/// `Math.sin`, including V8's multiprecision argument reduction for every finite f64.
pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_sin(x, 0.0, false);
    }
    if ix >= 0x7ff0_0000 {
        return if x.is_nan() { quiet_nan(x) } else { f64::from_bits(0xfff8_0000_0000_0000) };
    }
    let (n, [a, b]) = rem_pio2(x);
    match n & 3 {
        0 => kernel_sin(a, b, true),
        1 => kernel_cos(a, b),
        2 => -kernel_sin(a, b, true),
        _ => -kernel_cos(a, b),
    }
}

/// `Math.cos`.
pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7ff0_0000 {
        return if x.is_nan() { quiet_nan(x) } else { f64::from_bits(0xfff8_0000_0000_0000) };
    }
    let (n, [a, b]) = rem_pio2(x);
    match n & 3 {
        0 => kernel_cos(a, b),
        1 => -kernel_sin(a, b, true),
        2 => -kernel_cos(a, b),
        _ => kernel_sin(a, b, true),
    }
}

/// `Math.tan`.
pub fn tan(x: f64) -> f64 {
    let ix = high(x) & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return kernel_tan(x, 0.0, 1);
    }
    if ix >= 0x7ff0_0000 {
        return if x.is_nan() { quiet_nan(x) } else { f64::from_bits(0xfff8_0000_0000_0000) };
    }
    let (n, [a, b]) = rem_pio2(x);
    kernel_tan(a, b, 1 - ((n & 1) << 1))
}
