//! The distribution kernels reached by the worksheet layer: the jStat 1.9.6 endpoint conventions (its unusual values at
//! the boundaries of each domain) over the accurate special-function kernels of `special.rs`; the jStat series, the
//! Lanczos log-gamma and the `1 - cdf` forms are gone.
//! Copyright (c) jStat contributors, MIT; full notice in office-stats-distributions/LICENSE.jstat.
// Decimal constants and manual NaN-sensitive domain comparisons are copied
// from jStat, not replaced by clippy's algebraically different suggestions.
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::manual_range_contains
)]
use crate::value::Value;
use super::special::{
    SpecialError, beta_inc, beta_inc_tiny, beta_inc_xy, gamma_inc, norm_quantile, solve_monotone,
};
use mixdog_js::math as m;
use std::cmp::Ordering;
use std::ops::*;

/// Private numeric carrier: V8's + and * choose the right NaN payload. Operator
/// implementations use the shared primitives, so spelling a source expression
/// does not let LLVM commute operands and silently change NaN bits.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
pub(super) struct N(pub(super) f64);
pub(super) fn n(x: f64) -> N {
    N(x)
}
impl From<f64> for N {
    fn from(x: f64) -> Self {
        N(x)
    }
}
impl PartialEq<f64> for N {
    fn eq(&self, r: &f64) -> bool {
        self.0 == *r
    }
}
impl PartialOrd<f64> for N {
    fn partial_cmp(&self, r: &f64) -> Option<Ordering> {
        self.0.partial_cmp(r)
    }
}
impl PartialEq<N> for f64 {
    fn eq(&self, r: &N) -> bool {
        *self == r.0
    }
}
impl PartialOrd<N> for f64 {
    fn partial_cmp(&self, r: &N) -> Option<Ordering> {
        self.partial_cmp(&r.0)
    }
}
fn sub(a: f64, b: f64) -> f64 {
    a - b
}
fn div(a: f64, b: f64) -> f64 {
    a / b
}
macro_rules! binary {
    ($trait:ident,$method:ident,$function:path,$assign:ident,$assign_method:ident) => {
        impl $trait for N {
            type Output = N;
            fn $method(self, r: N) -> N {
                N($function(self.0, r.0))
            }
        }
        impl $trait<f64> for N {
            type Output = N;
            fn $method(self, r: f64) -> N {
                self.$method(N(r))
            }
        }
        impl $trait<N> for f64 {
            type Output = N;
            fn $method(self, r: N) -> N {
                N(self).$method(r)
            }
        }
        impl $assign for N {
            fn $assign_method(&mut self, r: N) {
                *self = self.$method(r)
            }
        }
        impl $assign<f64> for N {
            fn $assign_method(&mut self, r: f64) {
                *self = self.$method(N(r))
            }
        }
    };
}
binary!(Add, add, m::add, AddAssign, add_assign);
binary!(Mul, mul, m::mul, MulAssign, mul_assign);
binary!(Sub, sub, sub, SubAssign, sub_assign);
binary!(Div, div, div, DivAssign, div_assign);
impl Neg for N {
    type Output = N;
    fn neg(self) -> N {
        N(-self.0)
    }
}
impl N {
    pub(super) fn value(self) -> Value {
        Value::Number(self.0)
    }
}
/// A cumulative probability and its right tail, each computed on its own side.
pub(super) type Tails = Result<(f64, f64), SpecialError>;
/// The quantile of a distribution whose cumulative and right tail at `x` come from `tails`. The root is found on the
/// tail that is at most one half (a right tail `1 - p` is exact for `p >= 1/2`), so a tiny probability keeps its
/// precision; `lo`/`hi` bracket the variable.
/// A root found at the bottom of the bracket is the lower end of the support, 0 (Excel: F.INV.RT(1,3,3), T.INV.2T(1,3)).
fn bottom_is_zero(root: Result<f64, SpecialError>) -> Result<f64, SpecialError> {
    root.map(|x| if x == X_MIN { 0.0 } else { x })
}
fn quantile(tails: impl Fn(f64) -> Tails, p: f64, lo: f64, hi: f64) -> Result<f64, SpecialError> {
    bottom_is_zero(quantile_unfloored(tails, p, lo, hi))
}
fn quantile_unfloored(tails: impl Fn(f64) -> Tails, p: f64, lo: f64, hi: f64) -> Result<f64, SpecialError> {
    if p > 0.5 {
        quantile_rt(tails, 1.0 - p, lo, hi)
    } else {
        solve_monotone(|x| tails(x).map(|t| t.0), lo, hi, false, p)
    }
}
/// The quantile whose right tail is `q`; for `q > 1/2` the left tail `1 - q` (exact) is the small one.
fn quantile_rt(tails: impl Fn(f64) -> Tails, q: f64, lo: f64, hi: f64) -> Result<f64, SpecialError> {
    bottom_is_zero(quantile_rt_unfloored(tails, q, lo, hi))
}
fn quantile_rt_unfloored(tails: impl Fn(f64) -> Tails, q: f64, lo: f64, hi: f64) -> Result<f64, SpecialError> {
    if q > 0.5 {
        solve_monotone(|x| tails(x).map(|t| t.0), lo, hi, false, 1.0 - q)
    } else {
        solve_monotone(|x| tails(x).map(|t| t.1), lo, hi, true, q)
    }
}
pub(super) fn beta_tails(x: f64, y: f64, a: f64, b: f64) -> Tails {
    beta_inc_xy(x, y, a, b)
}
pub(super) fn beta_inv(p: f64, a: f64, b: f64) -> Result<f64, SpecialError> {
    quantile(|x| beta_tails(x, 1.0 - x, a, b), p, X_MIN, 1.0)
}
pub(super) fn central_f_tails(x: f64, a: f64, b: f64) -> Tails {
    // written with u = b/a so that a*x cannot overflow for a finite x
    let u = b / a;
    beta_inc_xy(x / (x + u), u / (x + u), a / 2.0, b / 2.0)
}
pub(super) fn central_f_inv(p: f64, a: f64, b: f64) -> Result<f64, SpecialError> {
    quantile(|x| central_f_tails(x, a, b), p, X_MIN, X_MAX)
}
/// The bracket of a quantile variable on `(0, ∞)`; a root below the lower end is reported as 0.
const X_MIN: f64 = f64::MIN_POSITIVE;
const X_MAX: f64 = f64::MAX;
pub(super) fn chisquare_inv(p: f64, d: f64) -> Result<f64, SpecialError> {
    quantile(|x| chisquare_tails(x, d), p, X_MIN, X_MAX)
}
pub(super) fn chisquare_inv_rt(q: f64, d: f64) -> Result<f64, SpecialError> {
    quantile_rt(|x| chisquare_tails(x, d), q, X_MIN, X_MAX)
}
pub(super) fn central_f_inv_rt(q: f64, a: f64, b: f64) -> Result<f64, SpecialError> {
    quantile_rt(|x| central_f_tails(x, a, b), q, X_MIN, X_MAX)
}
/// The gamma cumulative and right tail at x for shape a and scale b (an estimate for the certified quantile).
fn gamma_tails(x: f64, a: f64, b: f64) -> Tails {
    gamma_inc(a, x / b)
}
/// Chi-square with d degrees: gamma with shape d/2 and scale 2.
fn chisquare_tails(x: f64, d: f64) -> Tails {
    gamma_inc(d / 2.0, x / 2.0)
}
pub(super) fn gamma_inv(p: f64, a: f64, b: f64) -> Result<f64, SpecialError> {
    quantile(|x| gamma_tails(x, a, b), p, X_MIN, X_MAX)
}
/// `mean + sd Φ⁻¹(p)`, the quantile taken from the tail the probability is in.
pub(super) fn normal_inv(p: f64, mean: f64, sd: f64) -> N {
    n(sd.mul_add(norm_quantile(p), mean))
}
pub(super) fn lognormal_inv(p: f64, mean: f64, sd: f64) -> N {
    n(sd.mul_add(norm_quantile(p), mean).exp())
}
/// Student's t cumulative and right tail. With `I = I_{d/(d+x²)}(d/2, 1/2)` the smaller tail is `I/2` and the other
/// is its complement, so the tail beyond a large `|x|` keeps full precision.
pub(super) fn student_tails(x: f64, d: f64) -> Tails {
    let small = 0.5 * student_two_tail(x, d)?.0;
    Ok(if x > 0.0 { (1.0 - small, small) } else { (small, 1.0 - small) })
}
/// `(P(|T| > |x|), P(|T| <= |x|))`, each on its own side.
fn student_two_tail(x: f64, d: f64) -> Tails {
    let ax = x.abs();
    // `t²` is never formed above sqrt(d): the argument `d/(d+t²)` is built from `d/t/t`, and below 1e-280 (where it
    // cannot be represented as a double for large `t`) its logarithm `ln d - 2 ln t` is used.
    let (xb, yb) = if ax < d.sqrt() {
        let s = d + ax * ax;
        (d / s, ax * ax / s)
    } else {
        let r = d / ax / ax;
        if r < 1e-280 {
            return beta_inc_tiny(d.ln() - 2.0 * ax.ln(), d / 2.0, 0.5);
        }
        (r / (1.0 + r), 1.0 / (1.0 + r))
    };
    beta_inc_xy(xb, yb, d / 2.0, 0.5)
}
/// The `t >= 0` with `P(|T| <= t) = c`, `c <= 1/2` (the probability near the median keeps its precision this way).
fn student_inv_central(c: f64, d: f64) -> Result<f64, SpecialError> {
    bottom_is_zero(solve_monotone(|t| student_two_tail(t, d).map(|v| v.1), X_MIN, X_MAX, false, c))
}
/// The `t >= 0` with `P(T > t) = q`, `q <= 1/2`; a quantile beyond the double range is an error.
fn student_inv_rt(q: f64, d: f64) -> Result<f64, SpecialError> {
    quantile_rt(|t| student_tails(t, d), q, X_MIN, X_MAX)
}
/// Two-tailed Student quantile: the t with P(|T| > t) = p (`p / 2` is exact).
pub(super) fn student_inv_2t(p: f64, d: f64) -> Result<f64, SpecialError> {
    if p > 0.5 {
        student_inv_central(1.0 - p, d)
    } else {
        student_inv_rt(p / 2.0, d)
    }
}
pub(super) fn student_inv(p: f64, d: f64) -> Result<f64, SpecialError> {
    // `|2p - 1|` is exact for `p` in [1/4, 3/4]
    let t = if p == 0.5 {
        Ok(0.0)
    } else if (0.25..0.75).contains(&p) {
        student_inv_central((2.0 * p - 1.0).abs(), d)
    } else if p > 0.5 {
        student_inv_rt(1.0 - p, d)
    } else {
        student_inv_rt(p, d)
    }?;
    Ok(if p < 0.5 { -t } else { t })
}
pub(super) fn binomial_tails(x: f64, trials: f64, p: f64) -> Tails {
    if x >= trials {
        return Ok((1.0, 0.0));
    }
    let (upper, lower) = beta_inc(p, x + 1.0, trials - x)?;
    Ok((lower, upper))
}
