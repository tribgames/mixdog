//! log Gamma on the positive axis by an exact integer shift to a Stirling point and the Stirling series, whose
//! remainder for real positive arguments is bounded by the first neglected term (DLMF 5.11.10-11). Bernoulli numbers
//! come from the tangent numbers (integers, Brent-Harvey's recurrence, no cancellation). Reflection separates the
//! integer and fractional parts exactly before `sinpi`.

use super::ball::{B, ln, pi, prec, sinpi};
use super::num::{Fl, Mag};
use std::cell::RefCell;
use std::cmp::Ordering;

thread_local! {
    static TANGENT: RefCell<Vec<Fl>> = const { RefCell::new(Vec::new()) };
}

/// The tangent numbers T_1..T_n (index 0 unused).
fn tangent(n: usize) -> Vec<Fl> {
    if let Some(t) = TANGENT.with(|t| {
        let t = t.borrow();
        (t.len() > n).then(|| t[..=n].to_vec())
    }) {
        return t;
    }
    let m = (n + 1).max(64).max(2 * TANGENT.with(|t| t.borrow().len()));
    let mut t = vec![Fl::zero(); m + 1];
    t[1] = Fl::from_i64(1);
    for k in 2..=m {
        t[k] = t[k - 1].mul(&Fl::from_i64(k as i64 - 1));
    }
    for k in 2..=m {
        for j in k..=m {
            t[j] = t[j - 1].mul(&Fl::from_i64((j - k) as i64)).add(&t[j].mul(&Fl::from_i64((j - k + 2) as i64)));
        }
    }
    TANGENT.with(|c| *c.borrow_mut() = t.clone());
    t[..=n].to_vec()
}

/// `B_{2k} / (2k (2k-1)) = (-1)^(k-1) T_k / ((2k-1) 4^k (4^k - 1))`.
fn stirling_coeff(k: usize, t: &[Fl]) -> B {
    let four_k = Fl::pow2(2 * k as i64);
    let den = four_k.mul(&four_k.sub(&Fl::from_i64(1))).mul(&Fl::from_i64(2 * k as i64 - 1));
    let c = B::exact(t[k].clone()).div(&B::exact(den));
    if k % 2 == 1 { c } else { c.neg() }
}

/// The Stirling point: below it the argument is shifted up by an exact integer.
fn stirling_point() -> i64 {
    (prec() as f64 * 0.14) as i64 + 12
}

/// `sum_{k=1}^{K} B_{2k} / (2k(2k-1) y^(2k-1))` with the remainder bounded by the first neglected term, `y` at
/// least the Stirling point. Terms are added while they decrease and exceed 2^-(p+16) of the first.
fn stirling_series(y: &B) -> B {
    let p = prec() as i64;
    let inv = y.recip();
    let inv2 = inv.sqr();
    // the terms decrease while 2k < 2 pi y; past that the series is stopped at the latest
    let kmax = (3.1 * y.abs_lo().to_f64().min(1e6)) as usize + 2;
    let mut t = tangent(8);
    let mut pw = inv.clone();
    let mut s = B::zero();
    let mut first_top = i64::MIN;
    let mut last = Mag::INF;
    for k in 1..=kmax + 1 {
        if t.len() <= k {
            t = tangent(2 * k);
        }
        let term = stirling_coeff(k, &t).mul(&pw);
        let mag = term.abs_hi();
        if k == 1 {
            first_top = mag.top();
        }
        let stop = k > kmax || !mag.le(last) || mag.top() < first_top - p - 16;
        if stop {
            // the remainder after the previous term is bounded by this (first neglected) term
            return B { mid: s.mid, rad: s.rad.add(mag) };
        }
        s = s.add(&term);
        last = mag;
        pw = pw.mul(&inv2);
    }
    unreachable!()
}

/// `ln(2 pi)/2`.
pub fn half_ln_2pi() -> B {
    ln(&pi().mul_2exp(1)).mul_2exp(-1)
}

/// log Gamma(x) for a ball of positive reals.
pub fn lgamma(x: &B) -> B {
    if !x.is_pos() {
        return B::whole();
    }
    if x.rad.is_zero() && (x.mid == Fl::from_i64(1) || x.mid == Fl::from_i64(2)) {
        return B::zero();
    }
    let x0 = stirling_point();
    let lo = x.abs_lo();
    if lo.cmp(&Fl::from_i64(x0)) != Ordering::Less {
        return stirling_main(x).add(&stirling_series(x));
    }
    // shift: lgamma(x) = lgamma(x + n) - ln(x (x+1) ... (x+n-1)), n exact
    let n = (x0 as f64 - lo.to_f64()).ceil().max(1.0) as i64;
    let mut prod = x.clone();
    for i in 1..n {
        prod = prod.mul(&x.add(&B::int(i)));
    }
    let y = x.add(&B::int(n));
    stirling_main(&y).add(&stirling_series(&y)).sub(&ln(&prod))
}

/// `(y - 1/2) ln y - y + ln(2 pi)/2`.
fn stirling_main(y: &B) -> B {
    y.sub(&B::f(0.5)).mul(&ln(y)).sub(y).add(&half_ln_2pi())
}

/// `lgamma(y) - ((y - 1/2) ln y - y + ln(2 pi)/2)` without forming the difference for large y (no cancellation
/// between two numbers of order y ln y).
pub fn stirling_rem(y: &B) -> B {
    if !y.is_pos() {
        return B::whole();
    }
    let x0 = stirling_point();
    if y.abs_lo().cmp(&Fl::from_i64(x0)) != Ordering::Less {
        return stirling_series(y);
    }
    lgamma(y).sub(&stirling_main(y))
}

/// The sign and ln|Gamma(x)| of a double that is not a pole, or `None` at a pole (zero or a negative integer).
pub fn gamma_signed_log(x: f64) -> Option<(bool, B)> {
    if x > 0.0 {
        return Some((false, lgamma(&B::f(x))));
    }
    let f = Fl::from_f64(x);
    let fl = f.floor();
    let frac = f.sub(&fl);
    if frac.is_zero() {
        return None;
    }
    // x = -n + frac, frac in (0,1): Gamma(x) = pi / ((-1)^n sin(pi frac) Gamma(1 - x))
    // |x| < 2^53 here (larger doubles are integers, poles)
    let n_odd = fl.neg().to_i128().expect("a fractional double is below 2^53") % 2 == 1;
    let one_minus = B::exact(Fl::from_i64(1).sub(&f));
    let s = sinpi(&frac);
    let v = ln(&pi()).sub(&ln(&s)).sub(&lgamma(&one_minus));
    Some((n_odd, v))
}

/// `B_{2k}` (k >= 1) for every k up to `n`.
pub fn bernoulli_even(n: usize) -> Vec<B> {
    let t = tangent(n + 1);
    (1..=n).map(|k| bernoulli_2k(k, &t)).collect()
}

/// `B_{2k}` (k >= 1).
fn bernoulli_2k(k: usize, t: &[Fl]) -> B {
    stirling_coeff(k, t).mul_int((2 * k * (2 * k - 1)) as i64)
}

// Euler-Maclaurin remainders used below (f(x) = (w + x)^-s, every derivative of one sign on [0, inf)): after the
// terms k = 1..K, the remainder with the periodic Bernoulli function of odd order 2K+1 is at most
// `max|B_(2K+1)(x)| / (2K+1)! * int |f^(2K+1)| <= 2 zeta(2K+1) (2 pi)^-(2K+1) |f^(2K)(0)|`, and zeta(2K+1) <= zeta(3) < 2.

/// The shift point for `psi_tilde` / `hurwitz_all` (orders up to `s`): from it on the expansion terms fall below
/// 2^-(p+16) of the leading one before they would grow (their ratio is about ((s+2k)/(2 pi w))^2).
fn em_point(s: i64) -> i64 {
    (prec() as f64 * 0.12) as i64 + 2 * s + 12
}

/// An upper bound of `(2 pi)^-n`.
fn two_pi_pow_neg(n: u32) -> Mag {
    // 1/(2 pi) as a double times a margin above its rounding
    Mag::from_f64_up(std::f64::consts::FRAC_1_PI * 0.5 * (1.0 + 1e-15)).pow_up(n)
}

/// The exact integer shift taking the ball `z` (>= 1) to at least `x0`.
fn em_shift(z: &B, x0: i64) -> i64 {
    let lo = z.abs_lo();
    if lo.cmp(&Fl::from_i64(x0)) == Ordering::Less { x0 - lo.to_f64().floor() as i64 } else { 0 }
}

/// A wide ball (relative radius above 2^-8): f is monotone on it, so the hull of f at its two ends.
fn is_wide(z: &B) -> bool {
    !z.rad.is_zero() && z.rad.top() > z.mid.top() - 8
}

/// `psi(z) - ln z` for real z >= 1 (an increasing function). With `w = z + N` (N an exact integer shift):
/// `psi(w) - ln w = -1/(2w) - sum_{k=1..K} B_2k / (2k w^2k) + R`, `|R| <= 4 (2K)! (2 pi)^-(2K+1) w^-(2K+1)` (f = 1/(w+x)),
/// and `psi(z) - ln z = psi(w) - ln w + log1p(N/z) - sum_{i<N} 1/(z+i)`.
pub fn psi_tilde(z: &B) -> B {
    if is_wide(z) {
        return psi_tilde(&B::exact(z.lo())).union(&psi_tilde(&B::exact(z.hi())));
    }
    let p = prec() as i64;
    let x0 = em_point(1);
    let shift = em_shift(z, x0);
    let w = z.add(&B::int(shift));
    let inv = w.recip();
    let inv2 = inv.sqr();
    let mut s = inv.mul_2exp(-1).neg();
    let mut pw = inv2.clone(); // w^-2k
    let mut t = tangent(8);
    let mut fact = B::one(); // (2k-1)!
    let mut k = 1usize;
    loop {
        if t.len() <= k {
            t = tangent(2 * k);
        }
        s = s.sub(&bernoulli_2k(k, &t).mul(&pw).div_int(2 * k as i64));
        let bound = fact.mul_int(2 * k as i64).abs_hi().mul(two_pi_pow_neg(2 * k as u32 + 1)).mul(pw.mul(&inv).abs_hi());
        let bound = bound.mul_2exp(2);
        if bound.top() < s.abs_hi().top() - p - 16 || k as i64 > 4 * x0 {
            s = B { mid: s.mid, rad: s.rad.add(bound) };
            break;
        }
        fact = fact.mul_int((2 * k * (2 * k + 1)) as i64);
        pw = pw.mul(&inv2);
        k += 1;
    }
    if shift == 0 {
        return s;
    }
    let mut h = B::zero();
    for i in 0..shift {
        h = h.add(&z.add(&B::int(i)).recip());
    }
    s.add(&super::ball::log1p(&B::int(shift).div(z))).sub(&h)
}

/// `[zeta(2, z), ..., zeta(smax, z)]`, the Hurwitz zeta `sum_{i>=0} (z+i)^-s` for real z >= 1 (decreasing in z).
/// With `w = z + N`: `zeta(s, w) = w^(1-s)/(s-1) + w^-s/2 + sum_{k=1..K} B_2k (s)_(2k-1) / (2k)! w^(1-s-2k) + R`,
/// `|R| <= 4 (s)_(2K) (2 pi)^-(2K+1) w^(-s-2K)`, plus the exact shift `sum_{i<N} (z+i)^-s` (shared by every order).
pub fn hurwitz_all(z: &B, smax: i64) -> Vec<B> {
    if is_wide(z) {
        let (a, b) = (hurwitz_all(&B::exact(z.lo()), smax), hurwitz_all(&B::exact(z.hi()), smax));
        return a.iter().zip(&b).map(|(x, y)| x.union(y)).collect();
    }
    let p = prec() as i64;
    let x0 = em_point(smax);
    let shift = em_shift(z, x0);
    let w = z.add(&B::int(shift));
    let inv = w.recip();
    let inv2 = inv.sqr();
    let mut t = tangent(8);
    let mut out = Vec::new();
    let mut ws = inv.clone(); // w^-s
    for s in 2..=smax {
        ws = ws.mul(&inv);
        let mut acc = ws.mul(&w).div_int(s - 1).add(&ws.mul_2exp(-1));
        let mut rising = B::int(s); // (s)_(2k-1)
        let mut fact = B::int(2); // (2k)!
        let mut pw = ws.mul(&inv); // w^(1-s-2k)
        let mut k = 1usize;
        loop {
            if t.len() <= k {
                t = tangent(2 * k);
            }
            acc = acc.add(&bernoulli_2k(k, &t).mul(&rising).div(&fact).mul(&pw));
            let r2k = rising.mul_int(s + 2 * k as i64 - 1); // (s)_(2k)
            let bound = r2k.abs_hi().mul(two_pi_pow_neg(2 * k as u32 + 1)).mul(pw.mul(&inv).abs_hi()).mul_2exp(2);
            if bound.top() < acc.abs_hi().top() - p - 16 || k as i64 > 4 * x0 {
                acc = B { mid: acc.mid, rad: acc.rad.add(bound) };
                break;
            }
            rising = r2k.mul_int(s + 2 * k as i64);
            fact = fact.mul_int(((2 * k + 1) * (2 * k + 2)) as i64);
            pw = pw.mul(&inv2);
            k += 1;
        }
        out.push(acc);
    }
    for i in 0..shift {
        let q = z.add(&B::int(i)).recip();
        let mut pw = q.clone();
        for v in out.iter_mut() {
            pw = pw.mul(&q);
            *v = v.add(&pw);
        }
    }
    out
}
