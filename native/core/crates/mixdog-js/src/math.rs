//! JavaScript `Math` and `Number` operations, bit-exact with V8.
//!
//! Rust's `f64::exp`/`ln`/`powf`/`hypot` call the platform libm and differ from V8 in the last
//! bit for about one input in ten; the quota estimate chains thousands of them, so a different
//! last bit can move a rounded figure. V8 evaluates `Math.exp`, `log`, `log1p`, `expm1` and `pow`
//! with the fdlibm algorithms (`base/ieee754.cc`); these are the same algorithms. `sqrt` is
//! correctly rounded in both. `Math.hypot` is V8's scaled Kahan sum, not the C library's.

const HUGE: f64 = 1.0e300;
const TINY: f64 = 1.0e-300;
const TWO54: f64 = 1.801_439_850_948_198_4e16;
const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-01;
const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
const INVLN2: f64 = std::f64::consts::LOG2_E;
const P1: f64 = 1.666_666_666_666_660_190_37e-01;
const P2: f64 = -2.777_777_777_701_559_338_42e-03;
const P3: f64 = 6.613_756_321_437_934_361_17e-05;
const P4: f64 = -1.653_390_220_546_525_153_90e-06;
const P5: f64 = 4.138_136_797_057_238_460_39e-08;

fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as i32
}

fn low(x: f64) -> u32 {
    x.to_bits() as u32
}

fn words(high: i32, low: u32) -> f64 {
    f64::from_bits(((high as u32 as u64) << 32) | u64::from(low))
}

fn with_high(x: f64, high: i32) -> f64 {
    words(high, low(x))
}

fn with_low_zero(x: f64) -> f64 {
    words(high(x), 0)
}

/// `Math.exp`.
pub fn exp(x: f64) -> f64 {
    const O_THRESHOLD: f64 = 7.097_827_128_933_839_730_96e+02;
    const U_THRESHOLD: f64 = -7.451_332_191_019_411_084_20e+02;
    const TWOM1000: f64 = 9.332_636_185_032_188_789_90e-302;
    const E: f64 = std::f64::consts::E;
    let mut x = x;
    let mut hi = 0.0;
    let mut lo = 0.0;
    let mut k: i32 = 0;
    let mut hx = high(x);
    let xsb = ((hx >> 31) & 1) as usize;
    hx &= 0x7fff_ffff;
    if hx >= 0x4086_2E42 {
        if hx >= 0x7ff0_0000 {
            if (hx & 0xfffff) as u32 | low(x) != 0 {
                return x + x;
            }
            return if xsb == 0 { x } else { 0.0 };
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }
    if hx > 0x3fd6_2e42 {
        if hx < 0x3FF0_A2B2 {
            if x == 1.0 {
                return E;
            }
            hi = x - if xsb == 0 { LN2_HI } else { -LN2_HI };
            lo = if xsb == 0 { LN2_LO } else { -LN2_LO };
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
            let t = f64::from(k);
            hi = x - t * LN2_HI;
            lo = t * LN2_LO;
        }
        x = hi - lo;
    } else if hx < 0x3e30_0000 && HUGE + x > 1.0 {
        return 1.0 + x;
    }
    let t = x * x;
    let twopk = if k >= -1021 {
        words(0x3ff0_0000 + (k << 20), 0)
    } else {
        words(0x3ff0_0000 + ((k + 1000) << 20), 0)
    };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return 1.0 - ((x * c) / (c - 2.0) - x);
    }
    let y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * 8.988_465_674_311_58e307;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

const LG1: f64 = 6.666_666_666_666_735_130e-01;
const LG2: f64 = 3.999_999_999_940_941_908e-01;
const LG3: f64 = 2.857_142_874_366_239_149e-01;
const LG4: f64 = 2.222_219_843_214_978_396e-01;
const LG5: f64 = 1.818_357_216_161_805_012e-01;
const LG6: f64 = 1.531_383_769_920_937_332e-01;
const LG7: f64 = 1.479_819_860_511_658_591e-01;

/// `Math.log`.
pub fn ln(x: f64) -> f64 {
    let mut x = x;
    let mut hx = high(x);
    let lx = low(x);
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        if (hx & 0x7fff_ffff) as u32 | lx == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let mut i = (hx + 0x95f64) & 0x10_0000;
    x = with_high(x, hx | (i ^ 0x3ff0_0000));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = f64::from(k);
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.333_333_333_333_333_33 * f);
        if k == 0 {
            return f - r;
        }
        let dk = f64::from(k);
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = f64::from(k);
    let z = s * s;
    i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// `Math.log1p`.
pub fn ln_1p(x: f64) -> f64 {
    let hx = high(x);
    let ax = hx & 0x7fff_ffff;
    let mut k: i32 = 1;
    let mut f = 0.0;
    let mut hu: i32 = 0;
    let mut c = 0.0;
    if hx < 0x3FDA_827A {
        if ax >= 0x3ff0_0000 {
            if x == -1.0 {
                return f64::NEG_INFINITY;
            }
            return f64::NAN;
        }
        if ax < 0x3e20_0000 {
            if TWO54 + x > 0.0 && ax < 0x3c90_0000 {
                return x;
            }
            return x - x * x * 0.5;
        }
        if hx > 0 || hx <= 0xbfd2_bec4_u32 as i32 {
            k = 0;
            f = x;
            hu = 1;
        }
    } else if hx >= 0x7ff0_0000 {
        return x + x;
    }
    if k != 0 {
        let mut u;
        if hx < 0x4340_0000 {
            u = 1.0 + x;
            hu = high(u);
            k = (hu >> 20) - 1023;
            c = if k > 0 { 1.0 - (u - x) } else { x - (u - 1.0) };
            c /= u;
        } else {
            u = x;
            hu = high(u);
            k = (hu >> 20) - 1023;
            c = 0.0;
        }
        hu &= 0x000f_ffff;
        if hu < 0x6a09e {
            u = with_high(u, hu | 0x3ff0_0000);
        } else {
            k += 1;
            u = with_high(u, hu | 0x3fe0_0000);
            hu = (0x0010_0000 - hu) >> 2;
        }
        f = u - 1.0;
    }
    let hfsq = 0.5 * f * f;
    let kf = f64::from(k);
    if hu == 0 {
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            c += kf * LN2_LO;
            return kf * LN2_HI + c;
        }
        let r = hfsq * (1.0 - 0.666_666_666_666_666_66 * f);
        if k == 0 {
            return f - r;
        }
        return kf * LN2_HI - ((r - (kf * LN2_LO + c)) - f);
    }
    let s = f / (2.0 + f);
    let z = s * s;
    let r = z * (LG1 + z * (LG2 + z * (LG3 + z * (LG4 + z * (LG5 + z * (LG6 + z * LG7))))));
    if k == 0 {
        f - (hfsq - s * (hfsq + r))
    } else {
        kf * LN2_HI - ((hfsq - (s * (hfsq + r) + (kf * LN2_LO + c))) - f)
    }
}

/// `Math.expm1`.
pub fn exp_m1(x: f64) -> f64 {
    const O_THRESHOLD: f64 = 7.097_827_128_933_839_730_96e+02;
    const Q1: f64 = -3.333_333_333_333_313_164_28e-02;
    const Q2: f64 = 1.587_301_587_254_814_601_65e-03;
    const Q3: f64 = -7.936_507_578_674_879_424_73e-05;
    const Q4: f64 = 4.008_217_827_329_362_395_52e-06;
    const Q5: f64 = -2.010_992_181_836_243_713_26e-07;
    let mut x = x;
    let mut hx = high(x);
    let xsb = hx as u32 & 0x8000_0000;
    hx &= 0x7fff_ffff;
    if hx >= 0x4043_687A {
        if hx >= 0x4086_2E42 {
            if hx >= 0x7ff0_0000 {
                if (hx & 0xfffff) as u32 | low(x) != 0 {
                    return x + x;
                }
                return if xsb == 0 { x } else { -1.0 };
            }
            if x > O_THRESHOLD {
                return HUGE * HUGE;
            }
        }
        if xsb != 0 && x + TINY < 0.0 {
            return TINY - 1.0;
        }
    }
    let k: i32;
    let mut c = 0.0;
    if hx > 0x3fd6_2e42 {
        let hi;
        let lo;
        if hx < 0x3FF0_A2B2 {
            if xsb == 0 {
                hi = x - LN2_HI;
                lo = LN2_LO;
                k = 1;
            } else {
                hi = x + LN2_HI;
                lo = -LN2_LO;
                k = -1;
            }
        } else {
            k = (INVLN2 * x + if xsb == 0 { 0.5 } else { -0.5 }) as i32;
            let t = f64::from(k);
            hi = x - t * LN2_HI;
            lo = t * LN2_LO;
        }
        x = hi - lo;
        c = (hi - x) - lo;
    } else if hx < 0x3c90_0000 {
        let t = HUGE + x;
        return x - (t - (HUGE + x));
    } else {
        k = 0;
    }
    let hfx = 0.5 * x;
    let hxs = x * hfx;
    let r1 = 1.0 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
    let t = 3.0 - r1 * hfx;
    let mut e = hxs * ((r1 - t) / (6.0 - x * t));
    if k == 0 {
        return x - (x * e - hxs);
    }
    let twopk = words(0x3ff0_0000 + (k << 20), 0);
    e = x * (e - c) - c;
    e -= hxs;
    if k == -1 {
        return 0.5 * (x - e) - 0.5;
    }
    if k == 1 {
        return if x < -0.25 {
            -2.0 * (e - (x + 0.5))
        } else {
            1.0 + 2.0 * (x - e)
        };
    }
    if k <= -2 || k > 56 {
        let mut y = 1.0 - (e - x);
        if k == 1024 {
            y = y * 2.0 * 8.988_465_674_311_58e307;
        } else {
            y *= twopk;
        }
        return y - 1.0;
    }
    let mut t = 1.0;
    let y;
    if k < 20 {
        t = with_high(t, 0x3ff0_0000 - (0x20_0000 >> k));
        y = (t - (e - x)) * twopk;
    } else {
        t = with_high(t, (0x3ff - k) << 20);
        y = ((x - (e + t)) + 1.0) * twopk;
    }
    y
}

/// `Math.pow` and the `**` operator.
pub fn pow(x: f64, y: f64) -> f64 {
    const BP: [f64; 2] = [1.0, 1.5];
    const DP_H: [f64; 2] = [0.0, 5.849_624_872_207_641_601_56e-01];
    const DP_L: [f64; 2] = [0.0, 1.350_039_202_129_748_971_28e-08];
    const TWO53: f64 = 9_007_199_254_740_992.0;
    const L1: f64 = 5.999_999_999_999_946_487_25e-01;
    const L2: f64 = 4.285_714_285_785_501_842_52e-01;
    const L3: f64 = 3.333_333_298_183_774_329_18e-01;
    const L4: f64 = 2.727_281_238_085_340_064_89e-01;
    const L5: f64 = 2.306_607_457_755_617_540_67e-01;
    const L6: f64 = 2.069_750_178_003_384_177_84e-01;
    const LG2_: f64 = std::f64::consts::LN_2;
    const LG2_H: f64 = 6.931_471_824_645_996_093_75e-01;
    const LG2_L: f64 = -1.904_654_299_957_768_045_25e-09;
    const OVT: f64 = 8.008_566_259_537_294_437_2e-17;
    const CP: f64 = 9.617_966_939_259_755_543_29e-01;
    const CP_H: f64 = 9.617_967_009_544_372_558_59e-01;
    const CP_L: f64 = -7.028_461_650_952_758_265_16e-09;
    const IVLN2: f64 = std::f64::consts::LOG2_E;
    const IVLN2_H: f64 = 1.442_695_021_629_333_496_09;
    const IVLN2_L: f64 = 1.925_962_991_126_617_468_87e-08;

    let hx = high(x);
    let lx = low(x);
    let hy = high(y);
    let ly = low(y);
    let mut ix = hx & 0x7fff_ffff;
    let iy = hy & 0x7fff_ffff;

    if iy as u32 | ly == 0 {
        return 1.0;
    }
    if ix > 0x7ff0_0000
        || (ix == 0x7ff0_0000 && lx != 0)
        || iy > 0x7ff0_0000
        || (iy == 0x7ff0_0000 && ly != 0)
    {
        return x + y;
    }

    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x4340_0000 {
            yisint = 2;
        } else if iy >= 0x3ff0_0000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    if ly == 0 {
        if iy == 0x7ff0_0000 {
            if (ix - 0x3ff0_0000) as u32 | lx == 0 {
                return f64::NAN;
            } else if ix >= 0x3ff0_0000 {
                return if hy >= 0 { y } else { 0.0 };
            }
            return if hy < 0 { -y } else { 0.0 };
        }
        if iy == 0x3ff0_0000 {
            return if hy < 0 { 1.0 / x } else { x };
        }
        if hy == 0x4000_0000 {
            return x * x;
        }
        if hy == 0x3fe0_0000 && hx >= 0 {
            return x.sqrt();
        }
    }

    let mut ax = x.abs();
    if lx == 0 && (ix == 0x7ff0_0000 || ix == 0 || ix == 0x3ff0_0000) {
        let mut z = ax;
        if hy < 0 {
            z = 1.0 / z;
        }
        if hx < 0 {
            if (ix - 0x3ff0_0000) | yisint == 0 {
                z = f64::NAN;
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    let mut n = (hx >> 31) + 1;
    if n | yisint == 0 {
        return f64::NAN;
    }
    let mut s = 1.0;
    if n | (yisint - 1) == 0 {
        s = -1.0;
    }

    let t1;
    let t2;
    if iy > 0x41e0_0000 {
        if iy > 0x43f0_0000 {
            if ix <= 0x3fef_ffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff0_0000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        if ix < 0x3fef_ffff {
            return if hy < 0 {
                s * HUGE * HUGE
            } else {
                s * TINY * TINY
            };
        }
        if ix > 0x3ff0_0000 {
            return if hy > 0 {
                s * HUGE * HUGE
            } else {
                s * TINY * TINY
            };
        }
        let t = ax - 1.0;
        let w = (t * t) * (0.5 - t * (0.333_333_333_333_333_333_333_3 - t * 0.25));
        let u = IVLN2_H * t;
        let v = t * IVLN2_L - w * IVLN2;
        let hi = with_low_zero(u + v);
        t1 = hi;
        t2 = v - (t1 - u);
    } else {
        n = 0;
        if ix < 0x0010_0000 {
            ax *= TWO53;
            n -= 53;
            ix = high(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000f_ffff;
        ix = j | 0x3ff0_0000;
        let k: usize;
        if j <= 0x3988E {
            k = 0;
        } else if j < 0xBB67A {
            k = 1;
        } else {
            k = 0;
            n += 1;
            ix -= 0x0010_0000;
        }
        ax = with_high(ax, ix);

        let u = ax - BP[k];
        let v = 1.0 / (ax + BP[k]);
        let ss = u * v;
        let s_h = with_low_zero(ss);
        let t_h = words(
            ((ix >> 1) | 0x2000_0000) + 0x0008_0000 + ((k as i32) << 18),
            0,
        );
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        let mut s2 = ss * ss;
        let mut r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        let t_h = with_low_zero(3.0 + s2 + r);
        let t_l = r - ((t_h - 3.0) - s2);
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        let p_h = with_low_zero(u + v);
        let p_l = v - (p_h - u);
        let z_h = CP_H * p_h;
        let z_l = CP_L * p_h + p_l * CP + DP_L[k];
        let t = f64::from(n);
        t1 = with_low_zero(((z_h + z_l) + DP_H[k]) + t);
        t2 = z_l - (((t1 - t) - DP_H[k]) - z_h);
    }

    let y1 = with_low_zero(y);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let mut z = p_l + p_h;
    let j = high(z);
    let i = low(z);
    if j >= 0x4090_0000 {
        if (j - 0x4090_0000) as u32 | i != 0 {
            return s * HUGE * HUGE;
        }
        if p_l + OVT > z - p_h {
            return s * HUGE * HUGE;
        }
    } else if (j & 0x7fff_ffff) >= 0x4090_cc00 {
        if (j.wrapping_sub(0xc090_cc00_u32 as i32)) as u32 | i != 0 {
            return s * TINY * TINY;
        }
        if p_l <= z - p_h {
            return s * TINY * TINY;
        }
    }

    let i = j & 0x7fff_ffff;
    let mut k = (i >> 20) - 0x3ff;
    n = 0;
    if i > 0x3fe0_0000 {
        n = j + (0x0010_0000 >> (k + 1));
        k = ((n & 0x7fff_ffff) >> 20) - 0x3ff;
        let t = words(n & !(0x000f_ffff >> k), 0);
        n = ((n & 0x000f_ffff) | 0x0010_0000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = with_low_zero(p_l + p_h);
    let u = t * LG2_H;
    let v = (p_l - (t - p_h)) * LG2_ + t * LG2_L;
    z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    let j = high(z).wrapping_add(((n as u32) << 20) as i32);
    if (j >> 20) <= 0 {
        z = scalbn(z, n);
    } else {
        z = with_high(z, high(z).wrapping_add(((n as u32) << 20) as i32));
    }
    s * z
}

/// `x * 2^n` as fdlibm's `scalbn` (the subnormal-result path of `pow`).
fn scalbn(x: f64, n: i32) -> f64 {
    const TWO54_: f64 = 1.801_439_850_948_198_4e16;
    const TWOM54: f64 = 5.551_115_123_125_783e-17;
    let mut x = x;
    let mut hx = high(x);
    let lx = low(x);
    let mut k = (hx & 0x7ff0_0000) >> 20;
    if k == 0 {
        if (lx | (hx & 0x7fff_ffff) as u32) == 0 {
            return x;
        }
        x *= TWO54_;
        hx = high(x);
        k = ((hx & 0x7ff0_0000) >> 20) - 54;
        if n < -50000 {
            return TINY * x;
        }
    }
    if k == 0x7ff {
        return x + x;
    }
    k += n;
    if k > 0x7fe {
        return HUGE * HUGE.copysign(x);
    }
    if k > 0 {
        return with_high(x, (hx & !0x7ff0_0000) | (k << 20));
    }
    if k <= -54 {
        return if n > 50000 {
            HUGE * HUGE.copysign(x)
        } else {
            TINY * TINY.copysign(x)
        };
    }
    k += 54;
    with_high(x, (hx & !0x7ff0_0000) | (k << 20)) * TWOM54
}

/// `Math.hypot(a, b, ..)`: the largest magnitude scales a compensated sum of squares.
pub fn hypot(values: &[f64]) -> f64 {
    let mut max = 0.0f64;
    let mut nan = false;
    for v in values {
        let v = v.abs();
        if v.is_nan() {
            nan = true;
        } else if v > max {
            max = v;
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    f64::sqrt(sum) * max
}

/// `Math.max(a, b)`: `NaN` wins, and `+0` is larger than `-0`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { b } else { a }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: `NaN` wins, and `-0` is smaller than `+0`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.round`: the nearest integer, ties toward +∞.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() || x.abs() >= 4_503_599_627_370_496.0 {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Number.prototype.toFixed(digits)` as text: the integer n for which n / 10^digits is nearest
/// the exact binary value, the larger n on a tie.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return crate::number::number_to_string(x);
    }
    let exact = format!("{:.*}", digits + 60, x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let (kept, rest) = fraction.split_at(digits);
    let mut digits_text: Vec<u8> = whole.bytes().chain(kept.bytes()).collect();
    if rest.as_bytes().first().is_some_and(|d| *d >= b'5') {
        let mut i = digits_text.len();
        loop {
            if i == 0 {
                digits_text.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_text[i] == b'9' {
                digits_text[i] = b'0';
            } else {
                digits_text[i] += 1;
                break;
            }
        }
    }
    let split = digits_text.len() - digits;
    let (int_part, frac_part) = digits_text.split_at(split);
    let mut text = String::from_utf8_lossy(int_part).into_owned();
    if digits > 0 {
        text.push('.');
        text.push_str(&String::from_utf8_lossy(frac_part));
    }
    if x < 0.0 {
        text.insert(0, '-');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bits(hex: &str) -> f64 {
        f64::from_bits(u64::from_str_radix(hex, 16).expect("hex"))
    }

    /// Node's answers (`testdata/math_v8.json`, recorded with V8 12.4) equal these bit for bit.
    #[test]
    fn equals_v8_bit_for_bit() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../testdata/math_v8.json")).expect("golden");
        assert!(cases.len() > 3000);
        for case in &cases {
            let name = case[0].as_str().expect("name");
            let args: Vec<f64> = case[1]
                .as_array()
                .expect("args")
                .iter()
                .map(|v| bits(v.as_str().expect("hex")))
                .collect();
            if name == "toFixed6" {
                assert_eq!(
                    to_fixed(args[0], 6),
                    case[2].as_str().expect("text"),
                    "toFixed {:?}",
                    args
                );
                continue;
            }
            let got = match name {
                "exp" => exp(args[0]),
                "log" => ln(args[0]),
                "log1p" => ln_1p(args[0]),
                "expm1" => exp_m1(args[0]),
                "pow" => pow(args[0], args[1]),
                "hypot" => hypot(&args),
                "round" => round(args[0]),
                other => panic!("unknown case {other}"),
            };
            let want = bits(case[2].as_str().expect("hex"));
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "{name}{args:?}: {got:e} vs {want:e}"
            );
        }
    }

    #[test]
    fn max_and_min_follow_ecmascript() {
        assert!(max(f64::NAN, 1.0).is_nan() && min(1.0, f64::NAN).is_nan());
        assert!(max(-0.0, 0.0).is_sign_positive() && min(0.0, -0.0).is_sign_negative());
        assert_eq!((max(1.0, 2.0), min(1.0, 2.0)), (2.0, 1.0));
    }
}
