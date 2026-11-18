//! Quantiles by searching the returned worksheet coordinate (design "Inversion"): finite doubles are ordered by their
//! bit patterns (sign folded), the bracket is bisected on those integer ranks, and every comparison is the certified
//! tail at the exact candidate against the exact target, on the side whose tail is at most 1/2 (no complement of a
//! rounded probability). The last two adjacent doubles are decided by the tail at their exact midpoint, so the result
//! is the nearest double of the quantile (subnormal results included).
//!
//! Equality rule. A comparison is first tried at 128..1024 bits. Undecided there, it is either an exact identity the
//! kernels return exactly (a median of a symmetric law: the normal mean, t at 0, equal beta shapes at the centre, F
//! with equal degrees at 1; those are decided as equal at once) or a candidate whose tail is within 2^-1000 relative of
//! the target. For the latter two more candidates at a quarter of the bracket on either side are compared up to 8192
//! bits: by strict monotonicity at most one of the three is an exact equality, and a decided probe shrinks the bracket
//! by at least a quarter. When all three stay undecided at 8192 bits, every point between the probes has a tail
//! within 2^-8000 of the target and the middle one is returned (bounded work: at most 64 such rounds).
//!
//! Fast path (a measured optimisation with a certificate): a double-precision estimate g from the earlier kernels is
//! accepted only when the tails at g (1 - 2^-46) and g (1 + 2^-46) bracket the target certainly; then the nearest
//! double of the quantile is within 2^-45 relative of g, and g's neighbourhood is refined by the same rank bisection
//! (a handful of steps). A rejected estimate only narrows the bracket, with probes at widening distances (2^-37 up to
//! 2^-5 relative) on the side where the quantile lies.

use super::ball::{B, ln, with_prec};
use super::dist::{beta_vx, complement, gamma_vx, halve, normal_tails_sq, t_two_sided};
use super::export::Val;
use super::num::Fl;
use super::quad::{Tails, beta_tails, gamma_tails};
use super::rat::Rat;
use crate::value::ErrorValue as E;
use std::cmp::Ordering;

/// The law whose quantile is sought; `lower(x)` increases with x.
#[derive(Clone, Copy, Debug)]
pub enum Law {
    Normal { mean: f64, sd: f64 },
    LogNormal { mean: f64, sd: f64 },
    Gamma { a: f64, scale: f64 },
    Beta { a: f64, b: f64, lo: f64, hi: f64 },
    /// Student t, one tail: lower = P(T <= x).
    T { d: f64 },
    /// Student t, two tails: lower = P(|T| <= x), x >= 0.
    T2 { d: f64 },
    F { d1: f64, d2: f64 },
}

fn half() -> Val {
    Val::Num(B::f(0.5))
}

fn tails(v: (Val, Val)) -> Tails {
    Tails { lower: v.0, upper: v.1 }
}

impl Law {
    /// The median of a symmetric law when it is a double: the tails there are exactly 1/2 (`tails` returns them
    /// exactly), so a target of 1/2 is decided as an equality at once.
    fn centre(&self) -> Option<f64> {
        match *self {
            Law::Normal { mean, .. } => Some(mean),
            Law::LogNormal { mean, .. } => (mean == 0.0).then_some(1.0),
            Law::T { .. } => Some(0.0),
            Law::Beta { a, b, lo, hi } => {
                let c = lo / 2.0 + hi / 2.0;
                (a == b && Fl::from_f64(c).mul_2exp(1) == Fl::from_f64(lo).add(&Fl::from_f64(hi))).then_some(c)
            }
            Law::F { d1, d2 } => (d1 == d2).then_some(1.0),
            Law::Gamma { .. } | Law::T2 { .. } => None,
        }
    }

    /// (P(X <= x), P(X > x)) at an exact dyadic x inside the support.
    fn tails(&self, x: &Fl) -> Tails {
        let xr = Rat::fl(x.clone());
        match *self {
            Law::Normal { mean, sd } => {
                let z = xr.sub(&Rat::f(mean)).div(&Rat::f(sd));
                tails(normal_tails_sq(&z.mul(&z).ball(), z.sign()))
            }
            Law::LogNormal { mean, sd } => {
                if x.is_zero() {
                    return tails((Val::Zero, Val::Num(B::one())));
                }
                if *x == Fl::from_i64(1) && mean == 0.0 {
                    return tails((half(), half()));
                }
                let z = ln(&B::exact(x.clone())).sub(&B::f(mean)).div(&B::f(sd));
                match z.cmp_zero() {
                    Some(s) => tails(normal_tails_sq(&z.sqr(), s)),
                    None => tails((Val::Num(B::whole()), Val::Num(B::whole()))),
                }
            }
            Law::Gamma { a, scale } => {
                if x.is_zero() {
                    return tails((Val::Zero, Val::Num(B::one())));
                }
                gamma_tails(&B::f(a), &gamma_vx(&xr.div(&Rat::f(scale)), a))
            }
            Law::Beta { a, b, lo, hi } => {
                let (dl, dh) = (xr.sub(&Rat::f(lo)), Rat::f(hi).sub(&xr));
                if dl.is_zero() {
                    return tails((Val::Zero, Val::Num(B::one())));
                }
                if dh.is_zero() {
                    return tails((Val::Num(B::one()), Val::Zero));
                }
                beta_tails(&B::f(a), &B::f(b), &beta_vx(&dl, &dh, a, b))
            }
            Law::T { d } => {
                if x.is_zero() {
                    return tails((half(), half()));
                }
                let outer = halve(&t_two_sided(&xr.mul(&xr), &B::f(d)));
                if x.is_neg() { tails((outer.clone(), complement(&outer))) } else { tails((complement(&outer), outer)) }
            }
            Law::T2 { d } => {
                if x.is_zero() {
                    return tails((Val::Zero, Val::Num(B::one())));
                }
                let two = t_two_sided(&xr.mul(&xr), &B::f(d));
                tails((complement(&two), two))
            }
            Law::F { d1, d2 } => {
                if x.is_zero() {
                    return tails((Val::Zero, Val::Num(B::one())));
                }
                beta_tails(&B::f(d1 / 2.0), &B::f(d2 / 2.0), &xr.ln())
            }
        }
    }
}

/// The certified order of a tail value against an exact target in (0, 1); `None` while undecided.
fn order(v: &Val, t: &Rat) -> Option<Ordering> {
    match v {
        Val::Zero => Some(Ordering::Less),
        Val::Num(b) => {
            if !b.is_finite() {
                return None;
            }
            if b.rad.is_zero() {
                return Some(Rat::fl(b.mid.clone()).cmp(t));
            }
            if Rat::fl(b.lo()).cmp(t) == Ordering::Greater {
                Some(Ordering::Greater)
            } else if Rat::fl(b.hi()).cmp(t) == Ordering::Less {
                Some(Ordering::Less)
            } else {
                None
            }
        }
        Val::Log(l) => {
            if !l.is_finite() {
                return None;
            }
            let lt = ln(&t.ball());
            if !lt.is_finite() {
                return None;
            }
            if l.lo().cmp(&lt.hi()) == Ordering::Greater {
                Some(Ordering::Greater)
            } else if l.hi().cmp(&lt.lo()) == Ordering::Less {
                Some(Ordering::Less)
            } else {
                None
            }
        }
    }
}

/// The target as both tails: P(X <= x) = p with p and 1 - p exact.
pub struct Target {
    lower: Rat,
    upper: Rat,
    use_upper: bool,
}

impl Target {
    /// P(X <= x) = p, 0 < p < 1.
    pub fn lower(p: f64) -> Target {
        Target::of(Rat::f(p))
    }

    /// P(X > x) = p, 0 < p < 1.
    pub fn upper(p: f64) -> Target {
        Target::of(Rat::int(1).sub(&Rat::f(p)))
    }

    fn of(lower: Rat) -> Target {
        let upper = Rat::int(1).sub(&lower);
        let use_upper = lower.cmp(&Rat::f(0.5)) == Ordering::Greater;
        Target { lower, upper, use_upper }
    }
}

/// The order of the quantile's tail at x against the target (Greater: x is above the quantile).
fn compare(law: &Law, x: &Fl, t: &Target, max_bits: u64) -> Option<Ordering> {
    let mut p = 128;
    loop {
        let r = with_prec(p, || {
            let tl = law.tails(x);
            if t.use_upper { order(&tl.upper, &t.upper).map(Ordering::reverse) } else { order(&tl.lower, &t.lower) }
        });
        if r.is_some() || p >= max_bits {
            return r;
        }
        p *= 2;
    }
}

/// Monotone integer rank of a finite double (signed zeros coalesced) and back.
fn rank(x: f64) -> i128 {
    if x < 0.0 { -i128::from((-x).to_bits()) } else { i128::from((x + 0.0).to_bits()) }
}

fn unrank(k: i128) -> f64 {
    if k < 0 { -f64::from_bits((-k) as u64) } else { f64::from_bits(k as u64) }
}

/// The quantile in [xlo, xhi] (finite doubles): `Err(#NUM!)` when it lies beyond them (an overflow past the
/// largest double, or a support end the law never reaches); `guess` is an optional double estimate.
pub fn quantile(law: Law, t: &Target, xlo: f64, xhi: f64, guess: Option<f64>) -> Result<f64, E> {
    const FAST: u64 = 1024;
    const FULL: u64 = 8192;
    let at = |k: i128, bits: u64| compare(&law, &Fl::from_f64(unrank(k)), t, bits);
    let (mut lo, mut hi) = (rank(xlo), rank(xhi));
    let mut lo_known = false;
    let mut hi_known = false;
    if let Some(c) = law.centre().filter(|c| *c > xlo && *c < xhi) {
        let k = rank(c);
        match at(k, FAST) {
            Some(Ordering::Equal) => return Ok(c),
            Some(Ordering::Less) => {
                lo = k;
                lo_known = true;
            }
            Some(Ordering::Greater) => {
                hi = k;
                hi_known = true;
            }
            None => {}
        }
    }
    // the estimate: two probes 2^-45 either side of it; bracketing the quantile, they certify a normal g to 2^-44
    // relative. Below 2 DBL_MIN (a bracket that may reach the subnormals) the probes are two ranks either side, and
    // the bisection then picks the nearest double.
    if let Some(g) = guess.filter(|g| g.is_finite() && *g > xlo && *g < xhi) {
        let normal = g.abs() >= 2.0 * f64::MIN_POSITIVE;
        let (a, b) = if normal {
            let w = g.abs() * f64::powi(2.0, -45);
            (rank(g - w), rank(g + w))
        } else {
            (rank(g) - 2, rank(g) + 2)
        };
        let oa = if a > lo && a < hi { at(a, FAST) } else { None };
        let ob = if b < hi && b > lo { at(b, FAST) } else { None };
        if normal && oa == Some(Ordering::Less) && ob == Some(Ordering::Greater) {
            return Ok(g);
        }
        for (k, o) in [(a, oa), (b, ob)] {
            match o {
                Some(Ordering::Less) if k > lo => {
                    lo = k;
                    lo_known = true;
                }
                Some(Ordering::Greater) if k < hi => {
                    hi = k;
                    hi_known = true;
                }
                Some(Ordering::Equal) => return Ok(unrank(k)),
                _ => {}
            }
        }
        // both probes on one side (an estimate a few 2^-45 off, as exp(mu + sd z) is at mu = 700): probes at
        // widening distances on that side, each a certified bound, until one passes the quantile, so the bisection
        // starts from a bracket of about the estimate's error instead of the whole range
        let up = ob == Some(Ordering::Less);
        let down = oa == Some(Ordering::Greater);
        if up || down {
            // below 2 DBL_MIN the distances are counted in ranks (GAMMA.INV(0.5,1,2.2250738585072014E-308), a
            // subnormal quantile, otherwise bisected the whole range)
            for (e, m) in [(-37, 6), (-29, 12), (-21, 20), (-13, 32), (-5, 44)] {
                let k = if normal {
                    let w = g.abs() * f64::powi(2.0, e);
                    rank(if up { g + w } else { g - w })
                } else if up {
                    rank(g) + (1i128 << m)
                } else {
                    rank(g) - (1i128 << m)
                };
                if k <= lo || k >= hi {
                    break;
                }
                match at(k, FAST) {
                    Some(Ordering::Less) if up => {
                        lo = k;
                        lo_known = true;
                    }
                    Some(Ordering::Greater) if down => {
                        hi = k;
                        hi_known = true;
                    }
                    Some(Ordering::Less) => {
                        lo = k;
                        lo_known = true;
                        break;
                    }
                    Some(Ordering::Greater) => {
                        hi = k;
                        hi_known = true;
                        break;
                    }
                    Some(Ordering::Equal) => return Ok(unrank(k)),
                    None => break,
                }
            }
        }
    }
    // the ends: the quantile must lie in (xlo, xhi]
    if !hi_known {
        match at(hi, FULL) {
            Some(Ordering::Less) => return Err(E::Num),
            Some(Ordering::Equal) => return Ok(unrank(hi)),
            _ => {}
        }
    }
    if !lo_known {
        match at(lo, FULL) {
            Some(Ordering::Equal) => return Ok(unrank(lo)),
            Some(Ordering::Greater) => return Err(E::Num),
            _ => {}
        }
    }
    // the smallest doubles of either sign: a quantile that underflows is decided in one comparison
    for k in [1i128, -1] {
        if k > lo && k < hi {
            match at(k, FAST) {
                Some(Ordering::Less) => lo = k,
                Some(Ordering::Greater) => hi = k,
                Some(Ordering::Equal) => return Ok(unrank(k)),
                None => {}
            }
        }
    }
    // rank bisection: tail(lo) < target <= tail(hi)
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        // undecided at 256 bits: the quantile may be very close to mid (GAMMA.INV(1E-300,1,1), whose quantile is
        // 1E-300 (1 + 5E-301), which 1024 bits do not separate). The exact midpoints to both neighbours are half a
        // unit away, so they are decided at once; bracketing the quantile they make mid its nearest double
        let mut o = at(mid, 256);
        if o.is_none() {
            let xm = unrank(mid);
            let below = Fl::from_f64(unrank(mid - 1)).add(&Fl::from_f64(xm)).mul_2exp(-1);
            let above = Fl::from_f64(xm).add(&Fl::from_f64(unrank(mid + 1))).mul_2exp(-1);
            if compare(&law, &below, t, FAST) == Some(Ordering::Less)
                && compare(&law, &above, t, FAST) == Some(Ordering::Greater)
            {
                return Ok(xm);
            }
            o = at(mid, FAST);
        }
        match o {
            Some(Ordering::Less) => lo = mid,
            Some(Ordering::Greater) => hi = mid,
            Some(Ordering::Equal) => return Ok(unrank(mid)),
            None => {
                // the equality rule: probes a quarter of the bracket either side, compared to the full precision
                let q = ((hi - lo) / 4).max(1);
                let (a, b) = (mid - q, mid + q);
                let mut moved = false;
                for k in [a, b] {
                    if k <= lo || k >= hi {
                        continue;
                    }
                    match at(k, FULL) {
                        Some(Ordering::Less) => {
                            lo = lo.max(k);
                            moved = true;
                        }
                        Some(Ordering::Greater) => {
                            hi = hi.min(k);
                            moved = true;
                        }
                        Some(Ordering::Equal) => return Ok(unrank(k)),
                        None => {}
                    }
                }
                if !moved {
                    match at(mid, FULL) {
                        Some(Ordering::Less) => lo = mid,
                        Some(Ordering::Greater) => hi = mid,
                        _ => return Ok(unrank(mid)),
                    }
                }
            }
        }
    }
    // adjacent doubles: the nearest one, from the tail at their exact midpoint (ties to the even neighbour)
    let (xl, xh) = (unrank(lo), unrank(hi));
    let mid = Fl::from_f64(xl).add(&Fl::from_f64(xh)).mul_2exp(-1);
    let even = if xl.to_bits() & 1 == 0 { xl } else { xh };
    Ok(match compare(&law, &mid, t, FULL) {
        Some(Ordering::Less) => xh,
        Some(Ordering::Greater) => xl,
        _ => even,
    })
}
