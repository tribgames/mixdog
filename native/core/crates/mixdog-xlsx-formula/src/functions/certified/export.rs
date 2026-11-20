//! The one place a certified value becomes a worksheet double. Kernels return a `Val` (a ball, a positive value
//! carried as its logarithm, or exact zero); `certify` re-runs a kernel at doubled precision until the enclosure
//! decides the double, and `prob` / `value` apply the output policy: a probability below DBL_MIN is Excel's flush to
//! zero, any other number rounds to nearest even (subnormals included), beyond the largest double is `#NUM!`.

use super::ball::{B, exp, with_prec};
use super::num::Fl;
use crate::value::ErrorValue as E;
use std::cmp::Ordering;

#[derive(Clone, Debug)]
pub enum Val {
    Zero,
    /// A real number (either sign).
    Num(B),
    /// A positive number `e^L`.
    Log(B),
}

/// Bits of relative accuracy required before a result is rounded (the export tolerance is 2^-40 = 1e-12 with a
/// wide margin; 2^-60 keeps the rounding itself the only error that matters).
const BITS: i64 = 60;
/// ln of 2^-1100 and 2^1100: outside, the class (zero / flush / overflow) is decided without an exponential.
const LN_TINY: f64 = -762.5;
const LN_HUGE: f64 = 762.5;

impl Val {
    pub fn decided(&self) -> bool {
        match self {
            Val::Zero => true,
            Val::Num(b) => b.is_exact_zero() || b.rel_ok(BITS) || (b.is_finite() && b.abs_hi().top() < -1100),
            Val::Log(l) => {
                l.is_finite()
                    && (l.rad.top() < -BITS || l.hi().cmp(&Fl::from_f64(LN_TINY)) == Ordering::Less || l.lo().cmp(&Fl::from_f64(LN_HUGE)) == Ordering::Greater)
            }
        }
    }
}

/// Precisions tried: 128 bits doubling to 8192. Every input is a double (exponent within 2^±1075), so a result
/// needing more than ~2300 bits of cancellation does not occur; if none decides, the last enclosure is returned and
/// exported as `#NUM!` (never a number the enclosure does not certify, never an unbounded loop).
pub fn certify(f: impl Fn() -> Val) -> Val {
    let mut p = 128;
    loop {
        let v = with_prec(p, &f);
        // an undecided enclosure at the last precision is a kernel defect (a cut that no precision separates, an
        // enclosure that does not tighten): tests stop on it
        debug_assert!(v.decided() || p < 8192, "certify: undecided at {p} bits: {v:?}");
        if v.decided() || p >= 8192 {
            return v;
        }
        p *= 2;
    }
}

/// The double of a decided value (nearest even), `None` when it is beyond the largest double or undecided.
fn round(v: &Val) -> Option<f64> {
    if !v.decided() {
        return None;
    }
    let x = match v {
        Val::Zero => 0.0,
        Val::Num(b) => b.to_f64(),
        Val::Log(l) => {
            if l.mid.cmp(&Fl::from_f64(LN_TINY)) == Ordering::Less {
                0.0
            } else if l.mid.cmp(&Fl::from_f64(LN_HUGE)) == Ordering::Greater {
                f64::INFINITY
            } else {
                with_prec(128, || exp(l)).to_f64()
            }
        }
    };
    x.is_finite().then_some(x)
}

/// A probability: Excel's subnormal flush, else nearest; beyond the double range `#NUM!`.
pub fn prob(v: &Val) -> Result<f64, E> {
    let x = round(v).ok_or(E::Num)?;
    Ok(if x.abs() < f64::MIN_POSITIVE { 0.0 } else { x })
}

/// Any other number: nearest even, subnormals included; beyond the double range `#NUM!`.
pub fn value(v: &Val) -> Result<f64, E> {
    round(v).ok_or(E::Num)
}

pub fn certified_prob(f: impl Fn() -> Val) -> Result<f64, E> {
    prob(&certify(f))
}

pub fn certified_value(f: impl Fn() -> Val) -> Result<f64, E> {
    value(&certify(f))
}
