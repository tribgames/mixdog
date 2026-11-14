// Adapted from bessel.js 1.0.2, Copyright (C) 2013-present SheetJS.
// Licensed under the Apache License, Version 2.0. You may not use this file except
// in compliance with that license, available at http://www.apache.org/licenses/LICENSE-2.0.
// Unless required by applicable law or agreed to in writing, software distributed
// under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
// CONDITIONS OF ANY KIND, either express or implied. See the License for the
// specific language governing permissions and limitations under the License.
//! Bessel 1.0.2, retaining its signed-domain tests, order rounding and recurrences.
use super::engineering::int32;
use mixdog_js::math as m;

fn horner(coefficients: &[f64], v: f64) -> f64 {
    coefficients.iter().rev().fold(0.0, |z, c| v * z + c)
}
fn iterate(x: f64, n: f64, mut f0: f64, mut f1: f64, sign: f64) -> f64 {
    if n == 0.0 {
        return f0;
    }
    if n == 1.0 {
        return f1;
    }
    let tdx = 2.0 / x;
    let mut f2 = f1;
    let mut order = 1.0;
    while order < n {
        f2 = f1 * order * tdx + sign * f0;
        f0 = f1;
        f1 = f2;
        order += 1.0
    }
    f2
}
const W: f64 = 0.636619772;
fn j0(x: f64) -> f64 {
    let mut y = x * x;
    if x < 8.0 {
        horner(J_B0_A1A, y) / horner(J_B0_A2A, y)
    } else {
        let xx = x - 0.785398164;
        y = 64.0 / y;
        let a1 = horner(J_B0_A1B, y);
        let a2 = horner(J_B0_A2B, y);
        m::sqrt(W / x) * (m::cos(xx) * a1 - m::sin(xx) * a2 * 8.0 / x)
    }
}
fn j1(x: f64) -> f64 {
    let mut y = x * x;
    let xx = m::abs(x) - 2.356194491;
    if m::abs(x) < 8.0 {
        x * horner(J_B1_A1A, y) / horner(J_B1_A2A, y)
    } else {
        y = 64.0 / y;
        let a1 = horner(J_B1_A1B, y);
        let a2 = horner(J_B1_A2B, y);
        let a = m::sqrt(W / m::abs(x)) * (m::cos(xx) * a1 - m::sin(xx) * a2 * 8.0 / m::abs(x));
        if x < 0.0 { -a } else { a }
    }
}
pub(super) fn j(x: f64, n: f64) -> f64 {
    let n = m::round(n);
    if !x.is_finite() {
        return if x.is_nan() { x } else { 0.0 };
    }
    if n < 0.0 {
        return if n % 2.0 != 0.0 && !(n % 2.0).is_nan() { -1.0 } else { 1.0 } * j(x, -n);
    }
    if x < 0.0 {
        return if n % 2.0 != 0.0 && !n.is_nan() {
            -1.0
        } else {
            1.0
        } * j(-x, n);
    }
    if n == 0.0 {
        return j0(x);
    }
    if n == 1.0 {
        return j1(x);
    }
    if x == 0.0 {
        return 0.0;
    }
    if x > n {
        return iterate(x, n, j0(x), j1(x), -1.0);
    }
    let mut order = 2.0 * m::floor((n + m::floor(m::sqrt(40.0 * n))) / 2.0);
    let (mut ret, mut bjp, mut sum, mut bj) = (0.0, 0.0, 0.0, 1.0);
    let mut jsum = false;
    let tox = 2.0 / x;
    while order > 0.0 {
        let bjm = order * tox * bj - bjp;
        bjp = bj;
        bj = bjm;
        if m::abs(bj) > 1e10 {
            bj *= 1e-10;
            bjp *= 1e-10;
            ret *= 1e-10;
            sum *= 1e-10
        }
        if jsum {
            sum += bj
        }
        jsum = !jsum;
        if order == n {
            ret = bjp
        }
        order -= 1.0;
    }
    sum = 2.0 * sum - bj;
    ret / sum
}
fn y0(x: f64) -> f64 {
    let mut y = x * x;
    let xx = x - 0.785398164;
    if x < 8.0 {
        horner(Y_B0_A1A, y) / horner(Y_B0_A2A, y) + W * j(x, 0.0) * m::ln(x)
    } else {
        y = 64.0 / y;
        let a1 = horner(Y_B0_A1B, y);
        let a2 = horner(Y_B0_A2B, y);
        m::sqrt(W / x) * (m::sin(xx) * a1 + m::cos(xx) * a2 * 8.0 / x)
    }
}
fn y1(x: f64) -> f64 {
    let mut y = x * x;
    let xx = x - 2.356194491;
    if x < 8.0 {
        x * horner(Y_B1_A1A, y) / horner(Y_B1_A2A, y) + W * (j(x, 1.0) * m::ln(x) - 1.0 / x)
    } else {
        y = 64.0 / y;
        let a1 = horner(Y_B1_A1B, y);
        let a2 = horner(Y_B1_A2B, y);
        m::sqrt(W / x) * (m::sin(xx) * a1 + m::cos(xx) * a2 * 8.0 / x)
    }
}
fn wrap(x: f64, n: f64, f0: fn(f64) -> f64, f1: fn(f64) -> f64, at_zero: f64, sign: f64) -> f64 {
    if x == 0.0 {
        return at_zero;
    }
    if x < 0.0 {
        return f64::NAN;
    }
    if n == 0.0 {
        return f0(x);
    }
    if n == 1.0 {
        return f1(x);
    }
    if n < 0.0 {
        return f64::NAN;
    }
    let n = f64::from(int32(n));
    iterate(x, n, f0(x), f1(x), sign)
}
pub(super) fn y(x: f64, n: f64) -> f64 {
    wrap(x, n, y0, y1, f64::NEG_INFINITY, -1.0)
}
fn i0(x: f64) -> f64 {
    if x <= 3.75 {
        horner(I_B0_A, x * x / (3.75 * 3.75))
    } else {
        m::exp(m::abs(x)) / m::sqrt(m::abs(x)) * horner(I_B0_B, 3.75 / m::abs(x))
    }
}
fn i1(x: f64) -> f64 {
    if x < 3.75 {
        x * horner(I_B1_A, x * x / (3.75 * 3.75))
    } else {
        (if x < 0.0 { -1.0 } else { 1.0 }) * m::exp(m::abs(x)) / m::sqrt(m::abs(x))
            * horner(I_B1_B, 3.75 / m::abs(x))
    }
}
pub(super) fn i(x: f64, n: f64) -> f64 {
    let n = m::round(n);
    if n == 0.0 {
        return i0(x);
    }
    if n == 1.0 {
        return i1(x);
    }
    if n < 0.0 {
        return f64::NAN;
    }
    if m::abs(x) == 0.0 {
        return 0.0;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    let (mut ret, mut bip, mut bi) = (0.0, 0.0, 1.0);
    let tox = 2.0 / m::abs(x);
    let mut order = 2.0 * m::round((n + m::round(m::sqrt(40.0 * n))) / 2.0);
    while order > 0.0 {
        let bim = order * tox * bi + bip;
        bip = bi;
        bi = bim;
        if m::abs(bi) > 1e10 {
            bi *= 1e-10;
            bip *= 1e-10;
            ret *= 1e-10
        }
        if order == n {
            ret = bip
        }
        order -= 1.0
    }
    ret *= i(x, 0.0) / bi;
    if x < 0.0 && n % 2.0 != 0.0 && !n.is_nan() {
        -ret
    } else {
        ret
    }
}
fn k0(x: f64) -> f64 {
    if x <= 2.0 {
        -m::ln(x / 2.0) * i(x, 0.0) + horner(K_B0_A, x * x / 4.0)
    } else {
        m::mul(m::exp(-x) / m::sqrt(x), horner(K_B0_B, 2.0 / x))
    }
}
fn k1(x: f64) -> f64 {
    if x <= 2.0 {
        m::ln(x / 2.0) * i(x, 1.0) + (1.0 / x) * horner(K_B1_A, x * x / 4.0)
    } else {
        m::mul(m::exp(-x) / m::sqrt(x), horner(K_B1_B, 2.0 / x))
    }
}
pub(super) fn k(x: f64, n: f64) -> f64 {
    wrap(x, n, k0, k1, f64::INFINITY, 1.0)
}

// Coefficients below retain original ascending order; horner traverses them in
// reverse, exactly as the source's .reverse() followed by its forward loop.

const J_B0_A1A: &[f64] = &[
    57568490574.0,
    -13362590354.0,
    651619640.7,
    -11214424.18,
    77392.33017,
    -184.9052456,
];
const J_B0_A2A: &[f64] = &[
    57568490411.0,
    1029532985.0,
    9494680.718,
    59272.64853,
    267.8532712,
    1.0,
];
const J_B0_A1B: &[f64] = &[
    1.0,
    -0.1098628627e-2,
    0.2734510407e-4,
    -0.2073370639e-5,
    0.2093887211e-6,
];
const J_B0_A2B: &[f64] = &[
    -0.1562499995e-1,
    0.1430488765e-3,
    -0.6911147651e-5,
    0.7621095161e-6,
    -0.934935152e-7,
];
const J_B1_A1A: &[f64] = &[
    72362614232.0,
    -7895059235.0,
    242396853.1,
    -2972611.439,
    15704.48260,
    -30.16036606,
];
const J_B1_A2A: &[f64] = &[
    144725228442.0,
    2300535178.0,
    18583304.74,
    99447.43394,
    376.9991397,
    1.0,
];
const J_B1_A1B: &[f64] = &[
    1.0,
    0.183105e-2,
    -0.3516396496e-4,
    0.2457520174e-5,
    -0.240337019e-6,
];
const J_B1_A2B: &[f64] = &[
    0.04687499995,
    -0.2002690873e-3,
    0.8449199096e-5,
    -0.88228987e-6,
    0.105787412e-6,
];
const Y_B0_A1A: &[f64] = &[
    -2957821389.0,
    7062834065.0,
    -512359803.6,
    10879881.29,
    -86327.92757,
    228.4622733,
];
const Y_B0_A2A: &[f64] = &[
    40076544269.0,
    745249964.8,
    7189466.438,
    47447.26470,
    226.1030244,
    1.0,
];
const Y_B0_A1B: &[f64] = &[
    1.0,
    -0.1098628627e-2,
    0.2734510407e-4,
    -0.2073370639e-5,
    0.2093887211e-6,
];
const Y_B0_A2B: &[f64] = &[
    -0.1562499995e-1,
    0.1430488765e-3,
    -0.6911147651e-5,
    0.7621095161e-6,
    -0.934945152e-7,
];
const Y_B1_A1A: &[f64] = &[
    -0.4900604943e13,
    0.1275274390e13,
    -0.5153438139e11,
    0.7349264551e9,
    -0.4237922726e7,
    0.8511937935e4,
];
const Y_B1_A2A: &[f64] = &[
    0.2499580570e14,
    0.4244419664e12,
    0.3733650367e10,
    0.2245904002e8,
    0.1020426050e6,
    0.3549632885e3,
    1.0,
];
const Y_B1_A1B: &[f64] = &[
    1.0,
    0.183105e-2,
    -0.3516396496e-4,
    0.2457520174e-5,
    -0.240337019e-6,
];
const Y_B1_A2B: &[f64] = &[
    0.04687499995,
    -0.2002690873e-3,
    0.8449199096e-5,
    -0.88228987e-6,
    0.105787412e-6,
];
const I_B0_A: &[f64] = &[
    1.0,
    3.5156229,
    3.0899424,
    1.2067492,
    0.2659732,
    0.360768e-1,
    0.45813e-2,
];
const I_B0_B: &[f64] = &[
    0.39894228,
    0.1328592e-1,
    0.225319e-2,
    -0.157565e-2,
    0.916281e-2,
    -0.2057706e-1,
    0.2635537e-1,
    -0.1647633e-1,
    0.392377e-2,
];
const I_B1_A: &[f64] = &[
    0.5,
    0.87890594,
    0.51498869,
    0.15084934,
    0.2658733e-1,
    0.301532e-2,
    0.32411e-3,
];
const I_B1_B: &[f64] = &[
    0.39894228,
    -0.3988024e-1,
    -0.362018e-2,
    0.163801e-2,
    -0.1031555e-1,
    0.2282967e-1,
    -0.2895312e-1,
    0.1787654e-1,
    -0.420059e-2,
];
const K_B0_A: &[f64] = &[
    -0.57721566,
    0.42278420,
    0.23069756,
    0.3488590e-1,
    0.262698e-2,
    0.10750e-3,
    0.74e-5,
];
const K_B0_B: &[f64] = &[
    1.25331414,
    -0.7832358e-1,
    0.2189568e-1,
    -0.1062446e-1,
    0.587872e-2,
    -0.251540e-2,
    0.53208e-3,
];
const K_B1_A: &[f64] = &[
    1.0,
    0.15443144,
    -0.67278579,
    -0.18156897,
    -0.1919402e-1,
    -0.110404e-2,
    -0.4686e-4,
];
const K_B1_B: &[f64] = &[
    1.25331414,
    0.23498619,
    -0.3655620e-1,
    0.1504268e-1,
    -0.780353e-2,
    0.325614e-2,
    -0.68245e-3,
];
