// Adapted from Node v22.20.0 deps/v8/src/base/ieee754.cc.
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// Modified significantly by Google Inc. Copyright 2016 the V8 project authors.
// V8's BSD license is preserved in reference/LICENSE.v8.
//! fdlibm pi/2 reduction. The 24-bit convolution and summation order match V8.
//! Only precision=2 is needed by binary64 trig (the original's sole caller).
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::needless_range_loop,
    clippy::eq_op
)]
use super::{abs, high, low, scalbn, words};

const TWO_OVER_PI: [i32; 66] = [
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163,
    0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C,
    0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292,
    0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
    0x73A8C9, 0x60E27B, 0xC08C6B,
];
const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
    0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];
const TWO24: f64 = 1.67772160000000000000e+07;
const TWON24: f64 = 5.96046447753906250000e-08;

pub(super) fn rem_pio2(x: f64) -> (i32, [f64; 2]) {
    const INVPIO2: f64 = 6.36619772367581382433e-01;
    const PIO2_1: f64 = 1.57079632673412561417e+00;
    const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11;
    const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21;
    const PIO2_3T: f64 = 8.47842766036889956997e-32;
    let hx = high(x);
    let ix = hx & 0x7fff_ffff;
    if ix <= 0x3fe9_21fb {
        return (0, [x, 0.0]);
    }
    if ix < 0x4002_d97c {
        if hx > 0 {
            let mut z = x - PIO2_1;
            let tail = if ix != 0x3ff9_21fb {
                PIO2_1T
            } else {
                z -= PIO2_2;
                PIO2_2T
            };
            let a = z - tail;
            return (1, [a, (z - a) - tail]);
        }
        let mut z = x + PIO2_1;
        let tail = if ix != 0x3ff9_21fb {
            PIO2_1T
        } else {
            z += PIO2_2;
            PIO2_2T
        };
        let a = z + tail;
        return (-1, [a, (z - a) + tail]);
    }
    if ix <= 0x4139_21fb {
        let mut t = abs(x);
        let n = (t * INVPIO2 + 0.5) as i32;
        let nf = f64::from(n);
        let mut r = t - nf * PIO2_1;
        let mut w = nf * PIO2_1T;
        let mut a = r - w;
        if !(n < 32 && ix != NPIO2_HW[(n - 1) as usize]) {
            let j = ix >> 20;
            let mut i = j - ((high(a) >> 20) & 0x7ff);
            if i > 16 {
                t = r;
                w = nf * PIO2_2;
                r = t - w;
                w = nf * PIO2_2T - ((t - r) - w);
                a = r - w;
                i = j - ((high(a) >> 20) & 0x7ff);
                if i > 49 {
                    t = r;
                    w = nf * PIO2_3;
                    r = t - w;
                    w = nf * PIO2_3T - ((t - r) - w);
                    a = r - w
                }
            }
        }
        let b = (r - a) - w;
        return if hx < 0 { (-n, [-a, -b]) } else { (n, [a, b]) };
    }
    if ix >= 0x7ff0_0000 {
        return (0, [x - x, x - x]);
    }
    let e0 = (ix >> 20) - 1046;
    let mut z = words(ix.wrapping_sub(e0.wrapping_shl(20)), low(x));
    let mut tx = [0.0; 3];
    for i in 0..2 {
        tx[i] = f64::from(z as i32);
        z = (z - tx[i]) * TWO24
    }
    tx[2] = z;
    let mut nx = 3;
    while tx[nx - 1] == 0.0 {
        nx -= 1
    }
    let (n, [a, b]) = kernel_rem_pio2(&tx[..nx], e0);
    if hx < 0 { (-n, [-a, -b]) } else { (n, [a, b]) }
}

fn kernel_rem_pio2(x: &[f64], e0: i32) -> (i32, [f64; 2]) {
    const PIO2: [f64; 8] = [
        1.57079625129699707031e+00,
        7.54978941586159635335e-08,
        5.39030252995776476554e-15,
        3.28200341580791294123e-22,
        1.27065575308067607349e-29,
        1.22933308981111328932e-36,
        2.73370053816464559624e-44,
        2.16741683877804819444e-51,
    ];
    let jk = 4;
    let jx = x.len() - 1;
    let jv = ((e0 - 3) / 24).max(0) as usize;
    let mut q0 = e0 - 24 * (jv as i32 + 1);
    let mut iq = [0_i32; 20];
    let mut f = [0.0; 20];
    let mut fq = [0.0; 20];
    let mut q = [0.0; 20];
    for i in 0..=jx + jk {
        let j = jv as i32 - jx as i32 + i as i32;
        f[i] = if j < 0 {
            0.0
        } else {
            f64::from(TWO_OVER_PI[j as usize])
        }
    }
    for i in 0..=jk {
        let mut fw = 0.0;
        for j in 0..=jx {
            fw += x[j] * f[jx + i - j]
        }
        q[i] = fw
    }
    let mut jz = jk;
    let (mut z, mut n, mut ih);
    loop {
        z = q[jz];
        for i in 0..jz {
            let j = jz - i;
            let fw = f64::from((TWON24 * z) as i32);
            iq[i] = (z - TWO24 * fw) as i32;
            z = q[j - 1] + fw
        }
        z = scalbn(z, q0);
        z -= 8.0 * (z * 0.125).floor();
        n = z as i32;
        z -= f64::from(n);
        ih = 0;
        if q0 > 0 {
            let i = iq[jz - 1] >> (24 - q0);
            n += i;
            iq[jz - 1] -= i << (24 - q0);
            ih = iq[jz - 1] >> (23 - q0)
        } else if q0 == 0 {
            ih = iq[jz - 1] >> 23
        } else if z >= 0.5 {
            ih = 2
        }
        if ih > 0 {
            n += 1;
            let mut carry = 0;
            for i in 0..jz {
                let j = iq[i];
                if carry == 0 {
                    if j != 0 {
                        carry = 1;
                        iq[i] = 0x1000000 - j
                    }
                } else {
                    iq[i] = 0xffffff - j
                }
            }
            if q0 == 1 {
                iq[jz - 1] &= 0x7fffff
            } else if q0 == 2 {
                iq[jz - 1] &= 0x3fffff
            }
            if ih == 2 {
                z = 1.0 - z;
                if carry != 0 {
                    z -= scalbn(1.0, q0)
                }
            }
        }
        if z == 0.0 {
            let mut j = 0;
            for i in (jk..jz).rev() {
                j |= iq[i]
            }
            if j == 0 {
                let mut k = 1;
                while jk >= k && iq[jk - k] == 0 {
                    k += 1
                }
                for i in jz + 1..=jz + k {
                    f[jx + i] = f64::from(TWO_OVER_PI[jv + i]);
                    let mut fw = 0.0;
                    for j in 0..=jx {
                        fw += x[j] * f[jx + i - j]
                    }
                    q[i] = fw
                }
                jz += k;
                continue;
            }
        }
        break;
    }
    if z == 0.0 {
        jz -= 1;
        q0 -= 24;
        while iq[jz] == 0 {
            jz -= 1;
            q0 -= 24
        }
    } else {
        z = scalbn(z, -q0);
        if z >= TWO24 {
            let fw = f64::from((TWON24 * z) as i32);
            iq[jz] = (z - TWO24 * fw) as i32;
            jz += 1;
            q0 += 24;
            iq[jz] = fw as i32
        } else {
            iq[jz] = z as i32
        }
    }
    let mut fw = scalbn(1.0, q0);
    for i in (0..=jz).rev() {
        q[i] = fw * f64::from(iq[i]);
        fw *= TWON24
    }
    for i in (0..=jz).rev() {
        let mut fw = 0.0;
        for k in 0..=jk.min(jz - i) {
            fw += PIO2[k] * q[i + k]
        }
        fq[jz - i] = fw
    }
    let mut fw = 0.0;
    for i in (0..=jz).rev() {
        fw += fq[i]
    }
    let a = if ih == 0 { fw } else { -fw };
    fw = fq[0] - fw;
    for i in 1..=jz {
        fw += fq[i]
    }
    let b = if ih == 0 { fw } else { -fw };
    (n & 7, [a, b])
}
