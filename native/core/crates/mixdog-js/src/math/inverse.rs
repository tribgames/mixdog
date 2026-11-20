// Adapted from Node v22.20.0 deps/v8/src/base/ieee754.cc.
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// Modified significantly by Google Inc. Copyright 2016 the V8 project authors.
// V8's BSD license is preserved in reference/LICENSE.v8.
//! fdlibm inverse trigonometric operations. Evaluation order is intentional.
#![allow(clippy::excessive_precision, clippy::approx_constant)]
use super::{abs, domain_nan, high, low, quiet_nan, sqrt, with_low_zero};
const PI: f64 = 3.14159265358979311600e+00;
const PIO2_HI: f64 = 1.57079632679489655800e+00;
const PIO2_LO: f64 = 6.12323399573676603587e-17;
const PIO4_HI: f64 = 7.85398163397448278999e-01;
const PS0: f64 = 1.66666666666666657415e-01;
const PS1: f64 = -3.25565818622400915405e-01;
const PS2: f64 = 2.01212532134862925881e-01;
const PS3: f64 = -4.00555345006794114027e-02;
const PS4: f64 = 7.91534994289814532176e-04;
const PS5: f64 = 3.47933107596021167570e-05;
const QS1: f64 = -2.40339491173441421878e+00;
const QS2: f64 = 2.02094576023350569471e+00;
const QS3: f64 = -6.88283971605453293030e-01;
const QS4: f64 = 7.70381505559019352791e-02;

fn rational(z: f64) -> (f64, f64) {
    (z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5))))), 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4))))
}

/// `Math.acos`.
pub fn acos(x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x3ff0_0000 {
        if ((ix - 0x3ff0_0000) as u32 | low(x)) == 0 {
            return if hx > 0 { 0.0 } else { PI + 2.0 * PIO2_LO };
        }
        return domain_nan();
    }
    if ix < 0x3fe0_0000 {
        if ix <= 0x3c60_0000 {
            return PIO2_HI + PIO2_LO;
        }
        let z = x * x;
        let (p, q) = rational(z);
        let r = p / q;
        PIO2_HI - (x - (PIO2_LO - x * r))
    } else if hx < 0 {
        let z = (1.0 + x) * 0.5;
        let (p, q) = rational(z);
        let s = sqrt(z);
        let r = p / q;
        let w = r * s - PIO2_LO;
        PI - 2.0 * (s + w)
    } else {
        let z = (1.0 - x) * 0.5;
        let s = sqrt(z);
        let df = with_low_zero(s);
        let c = (z - df * df) / (s + df);
        let (p, q) = rational(z);
        let r = p / q;
        let w = r * s + c;
        2.0 * (df + w)
    }
}

/// `Math.asin`.
pub fn asin(x: f64) -> f64 {
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x3ff0_0000 {
        if ((ix - 0x3ff0_0000) as u32 | low(x)) == 0 {
            return x * PIO2_HI + x * PIO2_LO;
        }
        return domain_nan();
    }
    if ix < 0x3fe0_0000 {
        if ix < 0x3e40_0000 {
            return x;
        }
        let (p, q) = rational(x * x);
        let w = p / q;
        return x + x * w;
    }
    let w = 1.0 - abs(x);
    let mut t = w * 0.5;
    let (p, q) = rational(t);
    let s = sqrt(t);
    if ix >= 0x3fef_3333 {
        let w = p / q;
        t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO)
    } else {
        let w = with_low_zero(s);
        let c = (t - w * w) / (s + w);
        let r = p / q;
        let p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
        let q = PIO4_HI - 2.0 * w;
        t = PIO4_HI - (p - q)
    }
    if hx > 0 { t } else { -t }
}

/// `Math.atan`.
pub fn atan(mut x: f64) -> f64 {
    const HI: [f64; 4] = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
    const LO: [f64; 4] = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
    const AT: [f64; 11] = [
        3.33333333333329318027e-01,
        -1.99999999998764832476e-01,
        1.42857142725034663711e-01,
        -1.11111104054623557880e-01,
        9.09088713343650656196e-02,
        -7.69187620504482999495e-02,
        6.66107313738753120669e-02,
        -5.83357013379057348645e-02,
        4.97687799461593236017e-02,
        -3.65315727442169155270e-02,
        1.62858201153657823623e-02,
    ];
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix >= 0x4410_0000 {
        if ix > 0x7ff0_0000 || (ix == 0x7ff0_0000 && low(x) != 0) {
            return quiet_nan(x);
        }
        return if hx > 0 { HI[3] + LO[3] } else { -HI[3] - LO[3] };
    }
    let id: Option<usize>;
    if ix < 0x3fdc_0000 {
        if ix < 0x3e40_0000 {
            return x;
        }
        id = None
    } else {
        x = abs(x);
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                id = Some(0);
                x = (2.0 * x - 1.0) / (2.0 + x)
            } else {
                id = Some(1);
                x = (x - 1.0) / (x + 1.0)
            }
        } else if ix < 0x4003_8000 {
            id = Some(2);
            x = (x - 1.5) / (1.0 + 1.5 * x)
        } else {
            id = Some(3);
            x = -1.0 / x
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    match id {
        None => x - x * (s1 + s2),
        Some(id) => {
            let z = HI[id] - ((x * (s1 + s2) - LO[id]) - x);
            if hx < 0 { -z } else { z }
        }
    }
}

/// `Math.atan2(y, x)`. The positional arguments follow JavaScript, not Excel's names.
pub fn atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const PI_LO: f64 = 1.2246467991473531772e-16;
    let (hx, hy) = (high(x), high(y));
    let (ix, iy) = (hx & 0x7fff_ffff, hy & 0x7fff_ffff);
    let (lx, ly) = (low(x), low(y));
    if x.is_nan() || y.is_nan() {
        // MSVC's generated x+y propagates the first JavaScript argument y when
        // both are NaNs. Preserve that payload explicitly, independent of register allocation.
        return quiet_nan(if y.is_nan() { y } else { x });
    }
    if x == 1.0 {
        return atan(y);
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if (iy as u32 | ly) == 0 {
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix as u32 | lx) == 0 {
        return if hy < 0 { -PIO2_HI - TINY } else { PIO2_HI + TINY };
    }
    if ix == 0x7ff0_0000 {
        if iy == 0x7ff0_0000 {
            return match m {
                0 => PIO4_HI + TINY,
                1 => -PIO4_HI - TINY,
                2 => 3.0 * PIO4_HI + TINY,
                _ => -3.0 * PIO4_HI - TINY,
            };
        }
        return match m {
            0 => 0.0,
            1 => -0.0,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if iy == 0x7ff0_0000 {
        return if hy < 0 { -PIO2_HI - TINY } else { PIO2_HI + TINY };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        m &= 1;
        PIO2_HI + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0
    } else {
        atan(abs(y / x))
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}
