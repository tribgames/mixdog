//! Gamma and beta integrals as integrals of `exp(G(v))` over one monotone flank of a concave log density in
//! mode-centred log coordinates (design: "A common fallback with a remainder").
//!
//! * Gamma(a): `t = a e^v`, `G(v) = -a (e^v - 1 - v)`; beta(a, b) (a <= b by reflection, so t0 = a/(a+b) <= 1/2):
//!   `u = logit t = ln(a/b) + v`, `G(v) = a v - (a+b) log1p(t0 expm1 v)`. Both are strictly concave with G(0) = 0.
//! * A tail is the integral from the cut `v0` away from the mode. `D(s) = G(v0) - G(v0 + dir s)` is convex,
//!   increasing, zero at 0, and is formed by family `diff` functions that are sums of nonnegative terms (no
//!   cancellation at remote cuts).
//! * Truncation: find h = 2^j with D(h) >= 1 and D(h/2) < 2, both certain; convexity gives D(s) >= s/h beyond h,
//!   so the part beyond L h is at most h e^-L (L = `cut()`), while the part on [0, h/2] is at least (h/2) e^-2.
//! * Panels: degree-m Taylor polynomial about each panel centre (m = `deg()`); coefficient m+1 enclosed over the whole
//!   panel (series at the panel's ball) bounds the remainder by `2 M r^(m+2) / (m+2)` (Taylor's theorem). Panels failing their
//!   share of the absolute budget are bisected; a panel whose monotone bound `width * f(start)` fits the budget is
//!   taken as that bound.

use super::ball::{B, exp, expm1, expm1mx, ln, log1pmx, with_prec, prec};
use super::export::Val;
use super::gammafn::{half_ln_2pi, stirling_rem};
use super::num::{Fl, Mag};
use super::ser::Ser;
use std::cmp::Ordering;

/// The Taylor degree of a panel: at least 20, and a third of the budget bits so that panels of a quarter of the
/// local scale meet a raised precision without an exponential number of bisections.
fn deg() -> usize {
    (budget_bits() / 3).max(20) as usize
}
/// The relative accuracy of an integral or a lattice sum at the working precision: 2^-(prec - 56) (2^-72 at 128 bits),
/// so a raised precision also tightens the quadrature, not only the arithmetic.
fn budget_bits() -> i64 {
    prec() as i64 - 56
}

/// The truncation multiple L of the unit-drop scale h: the omitted tail h e^-L is below 2^-(budget + 4) of the lower
/// area (h/2) e^-2.
fn cut() -> i64 {
    ((budget_bits() + 8) as f64 * std::f64::consts::LN_2).ceil() as i64
}

pub trait Family {
    /// `G(v0 + d) - G(v0)` (<= 0 whenever d points away from the mode as seen from v0).
    fn diff(&self, v0: &B, d: &B) -> B;
    /// `G^(j)(v) / j!` for j = 1..=m (index j - 1).
    fn coeffs(&self, v: &B, m: usize) -> Vec<B>;
}

pub struct GammaF {
    pub a: B,
}

impl Family for GammaF {
    fn diff(&self, v0: &B, d: &B) -> B {
        // -a [expm1(v0) expm1(d) + expm1mx(d)]: both products have the sign of d v0 >= 0 on an outward flank
        expm1(v0).mul(&expm1(d)).add(&expm1mx(d)).mul(&self.a).neg()
    }

    fn coeffs(&self, v: &B, m: usize) -> Vec<B> {
        let ev = exp(v);
        let mut out = vec![expm1(v).mul(&self.a).neg()];
        let mut fact = B::one();
        for j in 2..=m {
            fact = fact.mul_int(j as i64);
            out.push(ev.mul(&self.a).div(&fact).neg());
        }
        out
    }
}

pub struct BetaF {
    pub ab: B,
    pub t0: B,
    pub u0: B,
}

impl BetaF {
    /// (t(v), 1 - t(v)) with t(v) = t0 e^v / (u0 + t0 e^v), written with e^-v for v > 0 (no overflow).
    fn t_pair(&self, v: &B) -> (B, B) {
        if v.mid.is_neg() {
            let e = exp(v);
            let den = self.u0.add(&self.t0.mul(&e));
            (self.t0.mul(&e).div(&den), self.u0.div(&den))
        } else {
            let e = exp(&v.neg());
            let den = self.t0.add(&self.u0.mul(&e));
            (self.t0.div(&den), self.u0.mul(&e).div(&den))
        }
    }

    /// t(v) - t0 = t0 u0 (e^v - 1) / (u0 + t0 e^v), from the same two forms.
    fn t_minus_t0(&self, v: &B) -> B {
        let k = self.t0.mul(&self.u0);
        if v.mid.is_neg() {
            let e = exp(v);
            k.mul(&expm1(v)).div(&self.u0.add(&self.t0.mul(&e)))
        } else {
            let e = exp(&v.neg());
            k.mul(&expm1(&v.neg()).neg()).div(&self.t0.add(&self.u0.mul(&e)))
        }
    }
}

/// `K(q, d) = log1p(q expm1 d) - q d >= 0`, choosing between it and its mirror `K(1 - q, -d)` (equal) so that
/// neither an exponential overflows nor the two second-order terms cancel.
fn kq(q: &B, p: &B, d: &B) -> B {
    let direct = |q: &B, d: &B| log1pmx(&q.mul(&expm1(d))).add(&q.mul(&expm1mx(d)));
    let big = d.abs_hi().top() >= 0;
    if !big {
        let mirror = q.mid.cmp(&p.mid) == Ordering::Greater;
        return if mirror { direct(p, &d.neg()) } else { direct(q, d) };
    }
    // |d| >= 1, written for d >= 0 (K(q, d) = K(p, -d) mirrors d < 0). The series form direct(q, d) while
    // |q expm1 d| < 1/4: both of its terms are of the size of q e^d, so over a ball of d its width stays relative
    // (the panel remainders evaluate K over whole panels); then the mirror direct(p, -d) while |p expm1(-d)| < 1/4;
    // otherwise K = p d + ln(q + p e^-d), whose logarithm holds a sum of two positive numbers (1 + y formed without
    // cancelling when q is tiny) and whose value is then at least of the order of its terms
    let (q, p, d) = if d.mid.is_neg() { (p, q, d.neg()) } else { (q, p, d.clone()) };
    if d.abs_hi().top() < 20 {
        let y = q.mul(&expm1(&d));
        if y.is_finite() && y.abs_hi().top() < -2 {
            return direct(q, &d);
        }
    }
    let em = exp(&d.neg());
    let y = p.mul(&em.sub(&B::one()));
    if y.abs_hi().top() < -2 {
        return direct(p, &d.neg());
    }
    p.mul(&d).add(&ln(&q.add(&p.mul(&em))))
}

impl Family for BetaF {
    fn diff(&self, v0: &B, d: &B) -> B {
        // G(v0+d) - G(v0) = -(a+b) [ (q - t0) d + K(q, d) ], q = t(v0)
        let (q, p) = self.t_pair(v0);
        self.t_minus_t0(v0).mul(d).add(&kq(&q, &p, d)).mul(&self.ab).neg()
    }

    fn coeffs(&self, v: &B, m: usize) -> Vec<B> {
        let (q, p) = self.t_pair(v);
        // G'(v) = (a+b)(t0 - t(v))
        let mut out = vec![self.t_minus_t0(v).mul(&self.ab).neg()];
        if m < 2 {
            return out;
        }
        // log(1 - t + t e^tau) = tau + log(t + (1-t) e^-tau): expand in the smaller of t, 1 - t
        let (r, flip) = if q.mid.cmp(&p.mid) == Ordering::Greater { (p, true) } else { (q, false) };
        let mut w = Ser::zeros(m + 1);
        let mut fact = B::one();
        for k in 1..=m {
            fact = fact.mul_int(k as i64);
            let c = r.div(&fact);
            w.0[k] = if flip && k % 2 == 1 { c.neg() } else { c };
        }
        let l = w.log1p_tail();
        for j in 2..=m {
            out.push(l.0[j].mul(&self.ab).neg());
        }
        out
    }
}

/// The series in tau of `G(v0 + dir (c + tau)) - G(v0 + dir c)` without its constant term, for an expansion
/// point given as the ball `x` of offsets (`dir c` or a whole panel).
pub(super) fn local_series<F: Family>(fam: &F, v0: &B, x: &B, dir: i64, m: usize) -> Ser {
    // the expansion point v0 + x with an exact midpoint: a rounded sum would move a lattice point 2^200 away from a
    // count of 1e99 by far more than the panel (whose coefficients then cover a far wider stretch of the flank)
    let v = B { mid: v0.mid.add(&x.mid), rad: v0.rad.add(x.rad) };
    let cs = fam.coeffs(&v, m);
    let mut s = Ser::zeros(m + 1);
    for j in 1..=m {
        s.0[j] = if dir < 0 && j % 2 == 1 { cs[j - 1].neg() } else { cs[j - 1].clone() };
    }
    s
}

/// ln of the integral of `exp(G(v0 + dir s) - G(v0))` over s in [0, len) (len `None`: to infinity), a decreasing
/// flank; `None` for an empty interval.
pub fn flank_log<F: Family>(fam: &F, v0: &B, dir: i64, len: Option<&Fl>) -> Option<B> {
    if len.is_some_and(Fl::is_zero) {
        return None;
    }
    let dfun = |s: &Fl| fam.diff(v0, &B::exact(if dir < 0 { s.neg() } else { s.clone() })).neg();
    // overlapping drop tests (D >= 1 certainly / D < 2 certainly), so no equality stalls the search; a value
    // decided by neither is an enclosure too wide at this precision, answered by the whole line (`certify` raises
    // the precision)
    let ge1 = |d: &B| d.is_finite() && d.lo().cmp(&Fl::from_i64(1)) != Ordering::Less;
    let lt2 = |d: &B| d.is_finite() && d.hi().cmp(&Fl::from_i64(2)) == Ordering::Less;
    // a finite flank shorter than its unit drop: the whole of it, with the lower area len e^-D(len) >= len e^-2
    if let Some(len) = len {
        let dl = dfun(len);
        if !ge1(&dl) {
            if !lt2(&dl) {
                return Some(B::whole());
            }
            let area_lo = with_prec(64, || exp(&B::exact(dl.hi().neg())).abs_lo()).mul(len);
            return Some(ln(&integrate(fam, v0, dir, &dfun, &Fl::zero(), len, &area_lo, Mag::ZERO)));
        }
    }
    // initial scale from the slope and the curvature at the cut
    let c = fam.coeffs(v0, 2);
    let est = |b: &B| -> Option<i64> {
        let m = b.abs_hi();
        if m.is_zero() || m.is_inf() { None } else { Some(m.top()) }
    };
    let j_slope = est(&c[0]).map(|t| -t);
    let j_curv = est(&c[1]).map(|t| -t / 2);
    let mut j = match (j_slope, j_curv) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => 0,
    };
    // j with D(2^j) >= 1 and D(2^(j-1)) < 2, both certain. D is convex, increasing and zero at 0, so walking down
    // reaches D < 2 and walking up reaches D >= 1 (D grows without bound on an infinite flank; a finite one shorter
    // than its unit drop was taken above) after finitely many doublings
    let mut dj = dfun(&Fl::pow2(j));
    // a start past an overflow (tiny shapes: the curvature scale 2^333 of a = 1e-200 on the upper flank, where
    // D = a e^s is no finite ball): walk down to the first finite drop, which the searches below then refine
    while !dj.is_finite() && j > -2200 {
        j -= 1;
        dj = dfun(&Fl::pow2(j));
    }
    if ge1(&dj) {
        loop {
            let dl = dfun(&Fl::pow2(j - 1));
            if lt2(&dl) {
                dj = dl;
                break;
            }
            if !ge1(&dl) {
                return Some(B::whole());
            }
            j -= 1;
        }
    } else if lt2(&dj) {
        loop {
            j += 1;
            let d = dfun(&Fl::pow2(j));
            if ge1(&d) {
                break;
            }
            if !lt2(&d) {
                return Some(B::whole());
            }
            dj = d;
        }
    } else {
        return Some(B::whole());
    }
    // dj = D(h/2) < 2; h = 2^j
    let h = Fl::pow2(j);
    let half_h = Fl::pow2(j - 1);
    let area_lo = with_prec(64, || exp(&B::exact(dj.hi().neg())).abs_lo()).mul(&half_h);
    let cut = cut();
    let mut end = h.mul(&Fl::from_i64(cut));
    let mut tail = Mag::of(&h).mul(Mag::pow2(-(budget_bits() + 8)));
    if let Some(len) = len.filter(|l| l.cmp(&end) != Ordering::Greater) {
        end = len.clone();
        tail = Mag::ZERO;
    }
    Some(ln(&integrate(fam, v0, dir, &dfun, &Fl::zero(), &end, &area_lo, tail)))
}

/// The integral of `exp(-D(s))` over [s0, s1] (D increasing), to an absolute budget of 2^-budget_bits() of `area_lo`,
/// plus `extra` (a truncated tail) in the radius.
#[allow(clippy::too_many_arguments)]
fn integrate<F: Family>(
    fam: &F,
    v0: &B,
    dir: i64,
    dfun: &dyn Fn(&Fl) -> B,
    s0: &Fl,
    s1: &Fl,
    area_lo: &Fl,
    extra: Mag,
) -> B {
    let total_w = s1.sub(s0);
    let budget = Mag::of(area_lo).mul_2exp(-budget_bits());
    let inv_w = super::ball::recip_up(&total_w);
    let mut sum = B::zero();
    let mut err = extra;
    // six initial panels; each is bisected until its Taylor remainder or its monotone bound fits its share
    let n0 = 6;
    let r0 = total_w.mul(&Fl::from_i64(1)).mul_2exp(-1);
    let r0 = B::exact(r0).div_int(n0).mid;
    let mut stack: Vec<(Fl, Fl, u32)> = (0..n0)
        .rev()
        .map(|i| (s0.add(&r0.mul(&Fl::from_i64(2 * i + 1))), r0.clone(), 0))
        .collect();
    // the panels must tile [s0, s1] exactly: the last one ends at s1
    if let Some(first) = stack.first_mut() {
        let start = first.0.sub(&first.1);
        let r = s1.sub(&start).mul_2exp(-1);
        *first = (start.add(&r), r, 0);
    }
    while let Some((c, r, depth)) = stack.pop() {
        let w2 = r.mul_2exp(1);
        let share = budget.mul(Mag::of(&w2)).mul(inv_w);
        let start = c.sub(&r);
        let fs = exp(&dfun(&start).neg());
        if !fs.is_finite() {
            return B::whole();
        }
        let bound = fs.abs_hi().mul(Mag::of(&w2));
        if bound.le(share) {
            // the integral is in [0, w f(start)]
            let half = bound.mul_2exp(-1);
            sum = sum.add(&B { mid: half.to_fl(), rad: half });
            continue;
        }
        if depth >= 2200 {
            // bisection limit, beyond the exponent range of the doubles (a flank of slope a = 1e-300 starts with a
            // curvature scale of 1 inside a stretch of 1e300, about 1000 halvings deep): the monotone enclosure
            // [w f(end), w f(start)] (never reached in the sweeps)
            let fe = exp(&dfun(&c.add(&r)).neg());
            let w = B::exact(w2.clone());
            sum = sum.add(&B::from_ends(&fe.abs_lo().mul(&w2), &fs.mul(&w).hi()));
            continue;
        }
        let (val, rem) = panel(fam, v0, dir, &c, &r);
        if rem.le(share) {
            sum = sum.add(&val);
            err = err.add(rem);
        } else {
            let q = r.mul_2exp(-1);
            stack.push((c.add(&q), q.clone(), depth + 1));
            stack.push((c.sub(&q), q, depth + 1));
        }
    }
    B { mid: sum.mid, rad: sum.rad.add(err) }
}

/// One Taylor panel: (value, remainder bound) of the integral over [c - r, c + r].
fn panel<F: Family>(fam: &F, v0: &B, dir: i64, c: &Fl, r: &Fl) -> (B, Mag) {
    let deg_ = deg();
    let dc = if dir < 0 { c.neg() } else { c.clone() };
    let xc = B::exact(dc.clone());
    let g0 = fam.diff(v0, &xc);
    let s = local_series(fam, v0, &xc, dir, deg_);
    let f = s.exp_shifted();
    // integral of sum f_j tau^j over [-r, r]: even powers only
    let rb = B::exact(r.clone());
    let r2 = rb.sqr();
    let mut pw = rb.mul_2exp(1);
    let mut acc = B::zero();
    let mut j = 0;
    while j <= deg_ {
        acc = acc.add(&f.0[j].mul(&pw).div_int(j as i64 + 1));
        pw = pw.mul(&r2);
        j += 2;
    }
    let val = acc.mul(&exp(&g0));
    // remainder: coefficient deg+1 over the whole panel times e^(g over the panel)
    let xp = B { mid: dc, rad: Mag::of(r) };
    let sp = local_series(fam, v0, &xp, dir, deg_ + 1);
    let fp = sp.exp_shifted();
    let gp = fam.diff(v0, &xp);
    let m = fp.0[deg_ + 1].abs_hi().mul(exp(&gp).abs_hi());
    let rem = m.mul(Mag::of(r).pow_up(deg_ as u32 + 2)).mul_2exp(1).mul(Mag::from_f64_up(1.0 / (deg_ as f64 + 2.0) * 1.0000001));
    (val, rem)
}

// ---------------------------------------------------------------- lattice sums

/// `sum_{j=1..R} j^l` for l = 0..=m: exact for R <= 64, else Faulhaber's formula
/// `(1/(l+1)) sum_i C(l+1, i) B_i R^(l+1-i)` (B_1 = +1/2) with ball Bernoulli numbers.
fn power_sums(r: &Fl, m: usize) -> Vec<B> {
    if r.cmp(&Fl::from_i64(64)) != Ordering::Greater {
        let n = r.to_i128().expect("a short count") as i64;
        let mut out = vec![B::zero(); m + 1];
        for j in 1..=n {
            let mut pw = Fl::from_i64(1);
            for v in out.iter_mut() {
                *v = v.add(&B::exact(pw.clone()));
                pw = pw.mul(&Fl::from_i64(j));
            }
        }
        return out;
    }
    let bern = super::gammafn::bernoulli_even(m / 2 + 1);
    let rb = B::exact(r.clone());
    let mut rp = vec![B::one()];
    for i in 1..=m + 1 {
        rp.push(rp[i - 1].mul(&rb));
    }
    (0..=m)
        .map(|l| {
            let mut s = B::zero();
            let mut c = 1i64; // C(l+1, i)
            for i in 0..=l {
                let bi = match i {
                    0 => Some(B::one()),
                    1 => Some(B::f(0.5)),
                    _ if i % 2 == 0 => Some(bern[i / 2 - 1].clone()),
                    _ => None,
                };
                if let Some(bi) = bi {
                    s = s.add(&bi.mul_int(c).mul(&rp[l + 1 - i]));
                }
                c = c * (l as i64 + 1 - i as i64) / (i as i64 + 1);
            }
            s.div_int(l as i64 + 1)
        })
        .collect()
}

/// ln of `sum_{j=0}^{len-1} exp(G(v0 + dir j) - G(v0))` for an integer start `v0` and a count `len >= 1`, where the
/// terms do not increase with j (a log-concave sequence past its mode). D(j) = G(v0) - G(v0 + dir j) is a convex
/// integer sequence with D(0) = 0.
pub fn lattice_log<F: Family>(fam: &F, v0: &B, dir: i64, len: &Fl) -> B {
    if len.cmp(&Fl::from_i64(1)) != Ordering::Greater {
        return B::zero();
    }
    let dfun = |j: &Fl| fam.diff(v0, &B::exact(if dir < 0 { j.neg() } else { j.clone() })).neg();
    let ge1 = |d: &B| d.is_finite() && d.lo().cmp(&Fl::from_i64(1)) != Ordering::Less;
    let lt2 = |d: &B| d.is_finite() && d.hi().cmp(&Fl::from_i64(2)) == Ordering::Less;
    // h = 2^e (e >= 0) with D(h) >= 1 and, for h >= 2, D(h/2) < 2; started from the curvature at v0
    let c = fam.coeffs(v0, 2);
    let last = len.sub(&Fl::from_i64(1));
    // D is evaluated only at offsets 1..=last (beyond them a cell of the table may be negative)
    let e_max = last.top();
    let mut e = {
        let m = c[1].abs_hi();
        if m.is_zero() || m.is_inf() { 0 } else { (-m.top() / 2).max(0) }
    }
    .min(e_max);
    let mut dh = dfun(&Fl::pow2(e));
    let mut dhalf: Option<B> = None;
    if ge1(&dh) {
        while e > 0 {
            let dl = dfun(&Fl::pow2(e - 1));
            if lt2(&dl) {
                dhalf = Some(dl);
                break;
            }
            if !ge1(&dl) {
                return B::whole();
            }
            e -= 1;
        }
    } else if lt2(&dh) {
        loop {
            if Fl::pow2(e + 1).cmp(&last) == Ordering::Greater {
                // the next doubling passes the end: the whole sum, untruncated; the terms 0..=2^e are each at least
                // e^-D(2^e) > e^-2
                let area_lo = with_prec(64, || exp(&B::exact(dh.hi().neg())).abs_lo()).mul(&Fl::pow2(e).add(&Fl::from_i64(1)));
                return ln(&lattice_sum(fam, v0, dir, &dfun, &last, &area_lo, Mag::ZERO));
            }
            e += 1;
            let d = dfun(&Fl::pow2(e));
            if ge1(&d) {
                dhalf = Some(dh);
                break;
            }
            if !lt2(&d) {
                return B::whole();
            }
            dh = d;
        }
    } else {
        return B::whole();
    }
    let h = Fl::pow2(e);
    let area_lo = match &dhalf {
        // the terms j = 0..h/2 are each at least e^-D(h/2)
        Some(d) => with_prec(64, || exp(&B::exact(d.hi().neg())).abs_lo()).mul(&Fl::pow2(e - 1).add(&Fl::from_i64(1))),
        None => Fl::from_i64(1),
    };
    // lattice truncation at L h, L = cut() + 2: the omitted part is at most e^-L (h + 1) against a part at least
    // (h/2 + 1) e^-2 before h/2, i.e. below 2 e^(2 - L) <= 2^-(budget + 8) of the sum
    let lcut = cut() + 2;
    let end = h.mul(&Fl::from_i64(lcut));
    let (stop, tail) = if end.cmp(len) == Ordering::Less {
        let t = Mag::of(&h.add(&Fl::from_i64(1))).mul(Mag::from_f64_up((-(lcut as f64)).exp() * 1.000001));
        (end.sub(&Fl::from_i64(1)), t)
    } else {
        (last, Mag::ZERO)
    };
    ln(&lattice_sum(fam, v0, dir, &dfun, &stop, &area_lo, tail))
}

/// `sum_{j=0}^{last} exp(-D(j))` to an absolute budget of 2^-budget_bits() of `area_lo`, plus `extra` in the radius. Integer
/// panels [A, B] about c = A + floor((B-A)/2): the degree-deg() Taylor polynomial summed exactly over the panel's
/// integers (power sums), the remainder `M sum |j - c|^(deg+1)` with M the next coefficient over the whole panel;
/// a panel whose monotone bound `count f(A)` fits its share is that bound; failing panels split at c; a singleton
/// is its term. At most `last + 1` leaves.
#[allow(clippy::too_many_arguments)]
fn lattice_sum<F: Family>(
    fam: &F,
    v0: &B,
    dir: i64,
    dfun: &dyn Fn(&Fl) -> B,
    last: &Fl,
    area_lo: &Fl,
    extra: Mag,
) -> B {
    let one = Fl::from_i64(1);
    let total = last.add(&one);
    let budget = Mag::of(area_lo).mul_2exp(-budget_bits());
    let inv_n = super::ball::recip_up(&total);
    let mut sum = B::zero();
    let mut err = extra;
    let mut stack: Vec<(Fl, Fl)> = vec![(Fl::zero(), last.clone())];
    while let Some((a, b)) = stack.pop() {
        let count = b.sub(&a).add(&one);
        let share = budget.mul(Mag::of(&count)).mul(inv_n);
        let fa = exp(&dfun(&a).neg());
        if !fa.is_finite() {
            return B::whole();
        }
        if a == b {
            sum = sum.add(&fa);
            continue;
        }
        let bound = fa.abs_hi().mul(Mag::of(&count));
        if bound.le(share) {
            let half = bound.mul_2exp(-1);
            sum = sum.add(&B { mid: half.to_fl(), rad: half });
            continue;
        }
        let c = a.add(&b.sub(&a).mul_2exp(-1).floor());
        if count.cmp(&Fl::from_i64(3)) != Ordering::Greater {
            stack.push((c.add(&one), b));
            stack.push((a.clone(), c.clone()));
            continue;
        }
        let (r, r2) = (c.sub(&a), b.sub(&c));
        let (val, rem) = lattice_panel(fam, v0, dir, &c, &r, &r2);
        if rem.le(share) {
            sum = sum.add(&val);
            err = err.add(rem);
        } else {
            stack.push((c.add(&one), b));
            stack.push((a, c));
        }
    }
    B { mid: sum.mid, rad: sum.rad.add(err) }
}

/// One integer panel `c + j`, j = -r..=r2 (r2 in {r, r + 1}): (value, remainder bound).
fn lattice_panel<F: Family>(fam: &F, v0: &B, dir: i64, c: &Fl, r: &Fl, r2: &Fl) -> (B, Mag) {
    let deg_ = deg();
    let sgn = |x: &Fl| if dir < 0 { x.neg() } else { x.clone() };
    let xc = B::exact(sgn(c));
    let g0 = fam.diff(v0, &xc);
    let f = local_series(fam, v0, &xc, dir, deg_).exp_shifted();
    let sl = power_sums(r, deg_ + 1);
    let sr = if r2 == r { sl.clone() } else { power_sums(r2, deg_ + 1) };
    let mut acc = B::zero();
    for l in 0..=deg_ {
        // sum_{j=-r}^{r2} j^l = (-1)^l S_l(r) + S_l(r2) (+1 for the j = 0 term when l = 0)
        let mut ps = if l % 2 == 0 { sl[l].add(&sr[l]) } else { sr[l].sub(&sl[l]) };
        if l == 0 {
            ps = ps.add(&B::one());
        }
        acc = acc.add(&f.0[l].mul(&ps));
    }
    let val = acc.mul(&exp(&g0));
    // the panel as a ball of offsets: [c - r, c + r2]
    let lo = c.sub(r);
    let hi = c.add(r2);
    let xp = B { mid: sgn(&lo.add(&hi).mul_2exp(-1)), rad: Mag::of(&hi.sub(&lo).mul_2exp(-1)) };
    let fp = local_series(fam, v0, &xp, dir, deg_ + 1).exp_shifted();
    // sup of G - G(v0) over the panel from the tangent at its start (G is concave): G(a) + max(0, G'(a)) (r + r2),
    // two point values instead of G over the whole panel ball, whose cell-by-cell enclosure would not see the
    // cancellation between the four log gammas
    let xa = B::exact(sgn(&lo));
    let slope = local_series(fam, v0, &xa, dir, 1).0[1].clone();
    let rise = if slope.mid.is_neg() && slope.is_neg() {
        Mag::ZERO
    } else {
        slope.abs_hi().mul(Mag::of(&hi.sub(&lo)))
    };
    let ga = fam.diff(v0, &xa);
    let gp = B { mid: ga.mid.clone(), rad: ga.rad.add(rise) };
    let m = fp.0[deg_ + 1].abs_hi().mul(exp(&gp).abs_hi());
    let rem = m.mul(sl[deg_ + 1].abs_hi().add(sr[deg_ + 1].abs_hi()));
    (val, rem)
}

/// Lower and upper tails as values: the far tail is an integral, the other its complement.
pub struct Tails {
    pub lower: Val,
    pub upper: Val,
}

fn assemble<F: Family>(fam: &F, norm: &B, vx: &B) -> Tails {
    let ge = vx.lo().cmp(&Fl::zero()) != Ordering::Less;
    let le = vx.hi().cmp(&Fl::zero()) != Ordering::Greater;
    if !ge && !le {
        // the cut is not separated from the mode at this precision (z = 1 - 1e-300 rounds to a ball holding 1): the
        // tails at the mode itself, widened by the width of the cut ball times the largest density, e^norm (G <= 0),
        // instead of a precision raised until the ball separates (2048 bits for a distance of 1e-300)
        let slack = exp(norm).abs_hi().mul(vx.abs_hi());
        let t = assemble(fam, norm, &B::zero());
        let widen = |v: Val| {
            let b = match v {
                Val::Zero => B::zero(),
                Val::Num(b) => b,
                Val::Log(l) => exp(&l),
            };
            Val::Num(B { mid: b.mid, rad: b.rad.add(slack) })
        };
        return Tails { lower: widen(t.lower), upper: widen(t.upper) };
    }
    let dir = if ge { 1 } else { -1 };
    let g = fam.diff(&B::zero(), vx);
    let far = norm.add(&g).add(&flank_log(fam, vx, dir, None).expect("an infinite flank"));
    if !far.is_finite() {
        return Tails { lower: Val::Num(B::whole()), upper: Val::Num(B::whole()) };
    }
    // the complement only when the far tail is at most 1/2 (no amplification); else the near side directly:
    // the mode's other flank plus the piece from the mode to the cut
    let near = if far.hi().cmp(&Fl::from_f64(-std::f64::consts::LN_2 + 1e-9)) == Ordering::Less {
        Val::Num(B::one().sub(&exp(&far)))
    } else {
        let len = if ge { vx.mid.clone() } else { vx.mid.neg() };
        let other = flank_log(fam, &B::zero(), -dir, None).expect("an infinite flank");
        // the cut's own radius moves the end of the piece; the integrand there is at most 1
        let piece = flank_log(fam, &B::zero(), dir, Some(&len)).map(|p| {
            if vx.rad.is_zero() { p } else { ln(&exp(&p).add(&B { mid: Fl::zero(), rad: vx.rad })) }
        });
        let both = match piece {
            Some(p) => super::ball::logaddexp(&other, &p),
            None => other,
        };
        Val::Log(norm.add(&both))
    };
    if ge {
        Tails { lower: near, upper: Val::Log(far) }
    } else {
        Tails { lower: Val::Log(far), upper: near }
    }
}

/// Regularised incomplete gamma (P, Q) at `t = a e^vx`, `a > 0` (vx = ln(t/a) given as a ball).
pub fn gamma_tails(a: &B, vx: &B) -> Tails {
    if a.abs_hi().top() < -20 && vx.hi().is_neg() {
        return small_shape_lower(a, vx);
    }
    // ln(a^a e^-a / Gamma(a)) = ln(a)/2 - ln(2 pi)/2 - R(a)
    let norm = ln(a).mul_2exp(-1).sub(&half_ln_2pi()).sub(&stirling_rem(a));
    assemble(&GammaF { a: a.clone() }, &norm, vx)
}

/// (P, Q) for a shape a < 2^-20 below the mode (t = a e^vx < a, so t < 2^-20). In mode-centred coordinates the lower
/// flank there has slope a, a stretch of 1/a (1e300 at a = 1e-300) that no panel tiling covers in bounded time;
/// instead the series `P = t^a e^-t / Gamma(1+a) * sum_k t^k / ((a+1)...(a+k))` (terms falling by t/(k+1) <= 2^-20,
/// tail after the last term below twice that term times t) with
/// `ln Gamma(1+a) = -gamma a + sum_{k>=2} (-1)^k zeta(k) a^k / k` (tail below 2 a^(n+1) / (1 - a), zeta(k) <= zeta(2)
/// < 2). ln P is a sum of terms of the size of ln P itself, so Q = -expm1(ln P) keeps its relative accuracy.
fn small_shape_lower(a: &B, vx: &B) -> Tails {
    use super::gammafn::{hurwitz_all, psi_tilde};
    let p = prec() as i64;
    let ln_t = ln(a).add(vx);
    let t = exp(&ln_t);
    // S - 1 = sum_{k>=1} t^k / ((a+1)...(a+k))
    let mut term = B::one();
    let mut s1 = B::zero();
    let mut k = 1i64;
    loop {
        term = term.mul(&t).div(&a.add(&B::int(k)));
        s1 = s1.add(&term);
        if term.abs_hi().top() < s1.abs_hi().top() - p - 8 || term.is_exact_zero() {
            s1 = B { mid: s1.mid, rad: s1.rad.add(term.abs_hi().mul(t.abs_hi()).mul_2exp(1)) };
            break;
        }
        k += 1;
    }
    // ln Gamma(1 + a): n terms with a^(n+1) below 2^-(p+8) of a
    let n = (p + 8) / (-a.abs_hi().top()).max(1) + 2;
    let zeta = hurwitz_all(&B::one(), n);
    let mut lg = psi_tilde(&B::one()).mul(a); // psi(1) = -gamma
    let mut pw = a.clone();
    for k in 2..=n {
        pw = pw.mul(a);
        let term = zeta[(k - 2) as usize].mul(&pw).div_int(k);
        lg = if k % 2 == 0 { lg.add(&term) } else { lg.sub(&term) };
    }
    let lg = B { mid: lg.mid, rad: lg.rad.add(pw.mul(a).abs_hi().mul_2exp(2)) };
    let ln_p = a.mul(&ln_t).sub(&t).sub(&lg).add(&super::ball::log1p(&s1));
    Tails { lower: Val::Log(ln_p.clone()), upper: Val::Num(expm1(&ln_p).neg()) }
}

/// Regularised incomplete beta (I, 1 - I) at logit coordinate `ln(a/b) + vx`, i.e. `vx = ln(x b / (y a))`.
pub fn beta_tails(a: &B, b: &B, vx: &B) -> Tails {
    if vx.is_exact_zero() && a.rad.is_zero() && b.rad.is_zero() && a.mid == b.mid {
        // the cut on the mode of equal shapes: both tails are 1/2 by symmetry (an exact median, which no
        // enclosure of the two integrals would decide against a target of 1/2)
        return Tails { lower: Val::Num(B::f(0.5)), upper: Val::Num(B::f(0.5)) };
    }
    if a.mid.cmp(&b.mid) == Ordering::Greater {
        let t = beta_tails(b, a, &vx.neg());
        return Tails { lower: t.upper, upper: t.lower };
    }
    let ab = a.add(b);
    // ln(t0^a u0^b / B(a,b)) = -( ln((a+b)/(ab))/2 + ln(2 pi)/2 + R(a) + R(b) - R(a+b) )
    let norm = ln(&ab.div(&a.mul(b)))
        .mul_2exp(-1)
        .add(&half_ln_2pi())
        .add(&stirling_rem(a))
        .add(&stirling_rem(b))
        .sub(&stirling_rem(&ab))
        .neg();
    let t0 = a.div(&ab);
    let u0 = b.div(&ab);
    let fam = BetaF { ab, t0, u0 };
    assemble(&fam, &norm, vx)
}

/// The log of the gamma density factor `t^a e^-t / Gamma(a)` at `t = a e^vx` (density in t times t).
pub fn gamma_log_mass(a: &B, vx: &B) -> B {
    let norm = ln(a).mul_2exp(-1).sub(&half_ln_2pi()).sub(&stirling_rem(a));
    norm.add(&GammaF { a: a.clone() }.diff(&B::zero(), vx))
}

/// The log of `t^a (1-t)^b / B(a,b)` at logit `ln(a/b) + vx`.
pub fn beta_log_mass(a: &B, b: &B, vx: &B) -> B {
    if a.mid.cmp(&b.mid) == Ordering::Greater {
        return beta_log_mass(b, a, &vx.neg());
    }
    let ab = a.add(b);
    let norm = ln(&ab.div(&a.mul(b)))
        .mul_2exp(-1)
        .add(&half_ln_2pi())
        .add(&stirling_rem(a))
        .add(&stirling_rem(b))
        .sub(&stirling_rem(&ab))
        .neg();
    let fam = BetaF { ab: ab.clone(), t0: a.div(&ab), u0: b.div(&ab) };
    norm.add(&fam.diff(&B::zero(), vx))
}

