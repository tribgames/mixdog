//! The jStat 1.9.6 kernels reached by formulajs distributions. Source operation
//! order/constants/loop bounds are retained, including its unusual endpoints.
//! Copyright (c) jStat contributors, MIT; full notice in office-stats-distributions/LICENSE.jstat.
// Decimal constants and manual NaN-sensitive domain comparisons are copied
// from jStat, not replaced by clippy's algebraically different suggestions.
#![allow(
    clippy::excessive_precision,
    clippy::approx_constant,
    clippy::manual_range_contains
)]
use crate::coerce::to_js_number;
use crate::value::Value;
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
    fn truthy(self) -> bool {
        self.0 != 0.0 && !self.0.is_nan()
    }
}
fn int32(x: N) -> i32 {
    super::engineering::int32(x.0)
}
pub(super) fn abs(x: impl Into<N>) -> N {
    N(m::abs(x.into().0))
}
pub(super) fn sqrt(x: impl Into<N>) -> N {
    N(m::sqrt(x.into().0))
}
pub(super) fn exp(x: impl Into<N>) -> N {
    N(m::exp(x.into().0))
}
pub(super) fn ln(x: impl Into<N>) -> N {
    N(m::ln(x.into().0))
}
pub(super) fn pow(x: impl Into<N>, y: impl Into<N>) -> N {
    N(m::pow(x.into().0, y.into().0))
}
fn floor(x: N) -> N {
    N(m::floor(x.0))
}
fn max(x: impl Into<N>, y: impl Into<N>) -> N {
    N(m::max(x.into().0, y.into().0))
}
fn min(x: impl Into<N>, y: impl Into<N>) -> N {
    N(m::min(x.into().0, y.into().0))
}
fn round(x: N) -> N {
    N(m::round(x.0))
}
fn erf(x: N) -> N {
    N(super::engineering::erf(&Value::Number(x.0)))
}
fn erfc(x: N) -> N {
    1.0 - erf(x)
}

pub(super) fn gammaln(x: impl Into<N>) -> N {
    let x = x.into();
    let mut y = x;
    let cof = [
        76.18009172947146,
        -86.50532032941677,
        24.01409824083091,
        -1.231739572450155,
        0.1208650973866179e-2,
        -0.5395239384953e-5,
    ];
    let mut ser = n(1.000000000190015);
    let mut tmp = x + 5.5;
    tmp -= (x + 0.5) * ln(tmp);
    for c in cof {
        y += 1.0;
        ser += c / y;
    }
    ln(2.5066282746310005 * ser / x) - tmp
}
pub(super) fn gammafn(x: impl Into<N>) -> N {
    let x = x.into();
    let p = [
        -1.716185138865495,
        24.76565080557592,
        -379.80425647094563,
        629.3311553128184,
        866.9662027904133,
        -31451.272968848367,
        -36144.413418691176,
        66456.14382024054,
    ];
    let q = [
        -30.8402300119739,
        315.35062697960416,
        -1015.1563674902192,
        -3107.771671572311,
        22538.118420980151,
        4755.8462775278811,
        -134659.9598649693,
        -115132.2596755535,
    ];
    let (mut fact, mut count, mut den, mut numerator, mut y) = (n(0.0), n(0.0), n(0.0), n(0.0), x);
    if x > 171.6243769536076 {
        return n(f64::INFINITY);
    }
    if y <= 0.0 {
        let residual = n(y.0 % 1.0) + 3.6e-16;
        if residual.truthy() {
            fact = (if int32(y) & 1 == 0 { 1.0 } else { -1.0 }) * n(std::f64::consts::PI)
                / n(m::sin((std::f64::consts::PI * residual).0));
            y = 1.0 - y;
        } else {
            return n(f64::INFINITY);
        }
    }
    let yi = y;
    let z;
    if y < 1.0 {
        z = y;
        y += 1.0;
    } else {
        count = n(f64::from(int32(y))) - 1.0;
        y -= count;
        z = y - 1.0;
    }
    for i in 0..8 {
        numerator = (numerator + p[i]) * z;
        den = den * z + q[i];
    }
    let mut result = numerator / den + 1.0;
    if yi < y {
        result /= yi;
    } else if yi > y {
        let mut i = 0.0;
        while i < count.0 {
            result *= y;
            y += 1.0;
            i += 1.0;
        }
    }
    if fact.truthy() {
        result = fact / result;
    }
    result
}
pub(super) fn low_reg_gamma(a: impl Into<N>, x: impl Into<N>) -> N {
    let (a, x) = (a.into(), x.into());
    let aln = gammaln(a);
    let mut ap = a;
    let mut sum = 1.0 / a;
    let mut del = sum;
    let mut b = x + 1.0 - a;
    let mut c = n(1.0 / 1e-30);
    let mut d = 1.0 / b;
    let mut h = d;
    let itmax = -f64::from(!int32(
        ln(if a >= 1.0 { a } else { 1.0 / a }) * 8.5 + a * 0.4 + 17.0,
    ));
    if x < 0.0 || a <= 0.0 {
        return n(f64::NAN);
    }
    let mut i = 1.0;
    if x < a + 1.0 {
        while i <= itmax {
            ap += 1.0;
            del *= x / ap;
            sum += del;
            i += 1.0;
        }
        return sum * exp(-x + a * ln(x) - aln);
    }
    while i <= itmax {
        let an = -n(i) * (n(i) - a);
        b += 2.0;
        d = an * d + b;
        c = b + an / c;
        d = 1.0 / d;
        h *= d * c;
        i += 1.0;
    }
    1.0 - h * exp(-x + a * ln(x) - aln)
}
#[allow(dead_code)]
pub(super) fn gammap(a: f64, x: f64) -> N {
    low_reg_gamma(a, x) * gammafn(a)
}
fn factorialln(x: N) -> N {
    if x < 0.0 {
        n(f64::NAN)
    } else {
        gammaln(x + 1.0)
    }
}
fn factorial(x: N) -> N {
    if x < 0.0 {
        n(f64::NAN)
    } else {
        gammafn(x + 1.0)
    }
}
fn combination(a: N, b: N) -> N {
    if a > 170.0 || b > 170.0 {
        exp(factorialln(a) - factorialln(b) - factorialln(a - b))
    } else {
        (factorial(a) / factorial(b)) / factorial(a - b)
    }
}
fn betaln(a: N, b: N) -> N {
    gammaln(a) + gammaln(b) - gammaln(a + b)
}
fn betafn(a: N, b: N) -> N {
    if a <= 0.0 || b <= 0.0 {
        n(f64::NAN)
    } else if a + b > 170.0 {
        exp(betaln(a, b))
    } else {
        gammafn(a) * gammafn(b) / gammafn(a + b)
    }
}
fn betacf(x: N, a: N, b: N) -> N {
    let qab = a + b;
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = n(1.0);
    let mut d = 1.0 - qab * x / qap;
    if abs(d) < 1e-30 {
        d = n(1e-30)
    }
    d = 1.0 / d;
    let mut h = d;
    for i in 1..=100 {
        let m = n(f64::from(i));
        let m2 = 2.0 * m;
        let mut aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if abs(d) < 1e-30 {
            d = n(1e-30)
        }
        c = 1.0 + aa / c;
        if abs(c) < 1e-30 {
            c = n(1e-30)
        }
        d = 1.0 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if abs(d) < 1e-30 {
            d = n(1e-30)
        }
        c = 1.0 + aa / c;
        if abs(c) < 1e-30 {
            c = n(1e-30)
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if abs(del - 1.0) < 3e-7 {
            break;
        }
    }
    h
}
// Original ibeta returns false outside [0,1]. All kernel callers use numeric
// coercion; central_f_cdf below preserves the directly observable Bool result.
fn ibeta(x: N, a: N, b: N) -> N {
    let bt = if x == 0.0 || x == 1.0 {
        n(0.0)
    } else {
        exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * ln(x) + b * ln(1.0 - x))
    };
    if x < 0.0 || x > 1.0 {
        return n(0.0);
    }
    if x < (a + 1.0) / (a + b + 2.0) {
        bt * betacf(x, a, b) / a
    } else {
        1.0 - bt * betacf(1.0 - x, b, a) / b
    }
}
fn ibetainv(p: N, a: N, b: N) -> N {
    let a1 = a - 1.0;
    let b1 = b - 1.0;
    if p <= 0.0 {
        return n(0.0);
    }
    if p >= 1.0 {
        return n(1.0);
    }
    let mut x;
    if a >= 1.0 && b >= 1.0 {
        let pp = if p < 0.5 { p } else { 1.0 - p };
        let t = sqrt(-2.0 * ln(pp));
        x = (2.30753 + t * 0.27061) / (1.0 + t * (0.99229 + t * 0.04481)) - t;
        if p < 0.5 {
            x = -x
        }
        let al = (x * x - 3.0) / 6.0;
        let h = 2.0 / (1.0 / (2.0 * a - 1.0) + 1.0 / (2.0 * b - 1.0));
        let w = (x * sqrt(al + h) / h)
            - (1.0 / (2.0 * b - 1.0) - 1.0 / (2.0 * a - 1.0)) * (al + 5.0 / 6.0 - 2.0 / (3.0 * h));
        x = a / (a + b * exp(2.0 * w));
    } else {
        let lna = ln(a / (a + b));
        let lnb = ln(b / (a + b));
        let t = exp(a * lna) / a;
        let u = exp(b * lnb) / b;
        let w = t + u;
        x = if p < t / w {
            pow(a * w * p, 1.0 / a)
        } else {
            1.0 - pow(b * w * (1.0 - p), 1.0 / b)
        }
    }
    let afac = -gammaln(a) - gammaln(b) + gammaln(a + b);
    for i in 0..10 {
        if x == 0.0 || x == 1.0 {
            return x;
        }
        let err = ibeta(x, a, b) - p;
        let density = exp(a1 * ln(x) + b1 * ln(1.0 - x) + afac);
        let u = err / density;
        let t = u / (1.0 - 0.5 * min(1.0, u * (a1 / x - b1 / (1.0 - x))));
        x -= t;
        if x <= 0.0 {
            x = 0.5 * (x + t)
        }
        if x >= 1.0 {
            x = 0.5 * (x + t + 1.0)
        }
        if abs(t) < 1e-8 * x && i > 0 {
            break;
        }
    }
    x
}
pub(super) fn gammapinv(p: impl Into<N>, a: impl Into<N>) -> N {
    let (p, a) = (p.into(), a.into());
    let a1 = a - 1.0;
    let gln = gammaln(a);
    if p >= 1.0 {
        return max(100.0, a + 100.0 * sqrt(a));
    }
    if p <= 0.0 {
        return n(0.0);
    }
    let mut x;
    let (mut lna1, mut afac) = (n(f64::NAN), n(f64::NAN));
    if a > 1.0 {
        lna1 = ln(a1);
        afac = exp(a1 * (lna1 - 1.0) - gln);
        let pp = if p < 0.5 { p } else { 1.0 - p };
        let t = sqrt(-2.0 * ln(pp));
        x = (2.30753 + t * 0.27061) / (1.0 + t * (0.99229 + t * 0.04481)) - t;
        if p < 0.5 {
            x = -x
        }
        x = max(
            1e-3,
            a * pow(1.0 - 1.0 / (9.0 * a) - x / (3.0 * sqrt(a)), 3.0),
        );
    } else {
        let t = 1.0 - a * (0.253 + a * 0.12);
        x = if p < t {
            pow(p / t, 1.0 / a)
        } else {
            1.0 - ln(1.0 - (p - t) / (1.0 - t))
        };
    }
    for _ in 0..12 {
        if x <= 0.0 {
            return n(0.0);
        }
        let err = low_reg_gamma(a, x) - p;
        let density = if a > 1.0 {
            afac * exp(-(x - a1) + a1 * (ln(x) - lna1))
        } else {
            exp(-x + a1 * ln(x) - gln)
        };
        let u = err / density;
        let t = u / (1.0 - 0.5 * min(1.0, u * ((a - 1.0) / x - 1.0)));
        x -= t;
        if x <= 0.0 {
            x = 0.5 * (x + t)
        }
        if abs(t) < 1e-8 * x {
            break;
        }
    }
    x
}
fn erfcinv(p: N) -> N {
    if p >= 2.0 {
        return n(-100.0);
    }
    if p <= 0.0 {
        return n(100.0);
    }
    let pp = if p < 1.0 { p } else { 2.0 - p };
    let t = sqrt(-2.0 * ln(pp / 2.0));
    let mut x = -0.70711 * ((2.30753 + t * 0.27061) / (1.0 + t * (0.99229 + t * 0.04481)) - t);
    for _ in 0..2 {
        let err = erfc(x) - pp;
        x += err / (1.12837916709551257 * exp(-x * x) - x * err);
    }
    if p < 1.0 { x } else { -x }
}
pub(super) fn beta_pdf(x: f64, a: f64, b: f64) -> N {
    let (x, a, b) = (n(x), n(a), n(b));
    if x > 1.0 || x < 0.0 {
        return n(0.0);
    }
    if a == 1.0 && b == 1.0 {
        return n(1.0);
    }
    if a < 512.0 && b < 512.0 {
        (pow(x, a - 1.0) * pow(1.0 - x, b - 1.0)) / betafn(a, b)
    } else {
        exp((a - 1.0) * ln(x) + (b - 1.0) * ln(1.0 - x) - betaln(a, b))
    }
}
pub(super) fn beta_cdf(x: f64, a: f64, b: f64) -> N {
    if x > 1.0 || x < 0.0 {
        n(if x > 1.0 { 1.0 } else { 0.0 })
    } else {
        ibeta(n(x), n(a), n(b))
    }
}
pub(super) fn beta_inv(p: f64, a: f64, b: f64) -> N {
    ibetainv(n(p), n(a), n(b))
}
pub(super) fn central_f_pdf(x: f64, a: f64, b: f64) -> N {
    let (x, a, b) = (n(x), n(a), n(b));
    if x < 0.0 {
        return n(0.0);
    }
    if a <= 2.0 {
        if x == 0.0 && a < 2.0 {
            return n(f64::INFINITY);
        }
        if x == 0.0 && a == 2.0 {
            return n(1.0);
        }
        return (1.0 / betafn(a / 2.0, b / 2.0))
            * pow(a / b, a / 2.0)
            * pow(x, a / 2.0 - 1.0)
            * pow(1.0 + (a / b) * x, -(a + b) / 2.0);
    }
    let p = (a * x) / (b + x * a);
    let q = b / (b + x * a);
    let f = a * q / 2.0;
    f * binomial_pdf((a - 2.0) / 2.0, (a + b - 2.0) / 2.0, p)
}
pub(super) fn central_f_cdf(x: f64, a: f64, b: f64) -> Value {
    let (x, a, b) = (n(x), n(a), n(b));
    if x < 0.0 {
        return Value::Number(0.0);
    }
    let ratio = (a * x) / (a * x + b);
    if ratio < 0.0 || ratio > 1.0 {
        return Value::Bool(false);
    }
    ibeta(ratio, a / 2.0, b / 2.0).value()
}
pub(super) fn central_f_inv(p: f64, a: f64, b: f64) -> N {
    let (a, b) = (n(a), n(b));
    b / (a * (1.0 / ibetainv(n(p), a / 2.0, b / 2.0) - 1.0))
}
pub(super) fn chisquare_pdf(x: f64, d: f64) -> N {
    let (x, d) = (n(x), n(d));
    if x < 0.0 {
        n(0.0)
    } else if x == 0.0 && d == 2.0 {
        n(0.5)
    } else {
        exp((d / 2.0 - 1.0) * ln(x) - x / 2.0 - (d / 2.0) * ln(2.0) - gammaln(d / 2.0))
    }
}
pub(super) fn chisquare_cdf(x: f64, d: f64) -> N {
    if x < 0.0 {
        n(0.0)
    } else {
        low_reg_gamma(n(d) / 2.0, n(x) / 2.0)
    }
}
pub(super) fn chisquare_inv(p: f64, d: f64) -> N {
    2.0 * gammapinv(p, 0.5 * n(d))
}
pub(super) fn exponential_pdf(x: f64, r: f64) -> N {
    if x < 0.0 {
        n(0.0)
    } else {
        n(r) * exp(-n(r) * x)
    }
}
pub(super) fn exponential_cdf(x: f64, r: f64) -> N {
    if x < 0.0 {
        n(0.0)
    } else {
        1.0 - exp(-n(r) * x)
    }
}
pub(super) fn gamma_pdf(x: f64, a: f64, b: f64) -> N {
    let (x, a, b) = (n(x), n(a), n(b));
    if x < 0.0 {
        n(0.0)
    } else if x == 0.0 && a == 1.0 {
        1.0 / b
    } else {
        exp((a - 1.0) * ln(x) - x / b - gammaln(a) - a * ln(b))
    }
}
pub(super) fn gamma_cdf(x: f64, a: f64, b: f64) -> N {
    if x < 0.0 {
        n(0.0)
    } else {
        low_reg_gamma(a, n(x) / b)
    }
}
pub(super) fn gamma_inv(p: f64, a: f64, b: f64) -> N {
    gammapinv(p, a) * b
}
pub(super) fn normal_pdf(x: f64, mean: f64, sd: f64) -> N {
    let (x, mean, sd) = (n(x), n(mean), n(sd));
    exp(-0.5 * ln(2.0 * std::f64::consts::PI) - ln(sd) - pow(x - mean, 2.0) / (2.0 * sd * sd))
}
pub(super) fn normal_cdf(x: f64, mean: f64, sd: f64) -> N {
    0.5 * (1.0 + erf((n(x) - mean) / sqrt(2.0 * n(sd) * sd)))
}
pub(super) fn normal_inv(p: f64, mean: f64, sd: f64) -> N {
    -1.41421356237309505 * n(sd) * erfcinv(2.0 * n(p)) + mean
}
pub(super) fn lognormal_pdf(x: f64, mean: f64, sd: f64) -> N {
    let (x, mean, sd) = (n(x), n(mean), n(sd));
    if x <= 0.0 {
        n(0.0)
    } else {
        exp(-ln(x)
            - 0.5 * ln(2.0 * std::f64::consts::PI)
            - ln(sd)
            - pow(ln(x) - mean, 2.0) / (2.0 * sd * sd))
    }
}
pub(super) fn lognormal_cdf(x: f64, mean: f64, sd: f64) -> N {
    if x < 0.0 {
        n(0.0)
    } else {
        0.5 + (0.5 * erf((ln(x) - mean) / sqrt(2.0 * n(sd) * sd)))
    }
}
pub(super) fn lognormal_inv(p: f64, mean: f64, sd: f64) -> N {
    exp(-1.41421356237309505 * n(sd) * erfcinv(2.0 * n(p)) + mean)
}
pub(super) fn student_cdf(x: f64, d: f64) -> N {
    let (x, d) = (n(x), n(d));
    let d2 = d / 2.0;
    ibeta((x + sqrt(x * x + d)) / (2.0 * sqrt(x * x + d)), d2, d2)
}
pub(super) fn student_inv(p: f64, d: f64) -> N {
    let (p, d) = (n(p), n(d));
    let mut x = ibetainv(2.0 * min(p, 1.0 - p), 0.5 * d, n(0.5));
    x = sqrt(d * (1.0 - x) / x);
    if p > 0.5 { x } else { -x }
}
// Binomial's separate continued fraction is not jStat.betacf and has no cap.
fn betinc(x: N, a: N, b: N, eps: f64) -> N {
    let (mut a0, mut b0, mut a1, mut b1, mut m9, mut a2) =
        (n(0.0), n(1.0), n(1.0), n(1.0), n(0.0), n(0.0));
    while abs((a1 - a2) / a1) > eps {
        a2 = a1;
        let mut c9 = -(a + m9) * (a + b + m9) * x / (a + 2.0 * m9) / (a + 2.0 * m9 + 1.0);
        a0 = a1 + c9 * a0;
        b0 = b1 + c9 * b0;
        m9 += 1.0;
        c9 = m9 * (b - m9) * x / (a + 2.0 * m9 - 1.0) / (a + 2.0 * m9);
        a1 = a0 + c9 * a1;
        b1 = b0 + c9 * b1;
        a0 /= b1;
        b0 /= b1;
        a1 /= b1;
        b1 = n(1.0);
    }
    a1 / a
}
pub(super) fn binomial_pdf(k: impl Into<N>, trials: impl Into<N>, p: impl Into<N>) -> N {
    let (k, trials, p) = (k.into(), trials.into(), p.into());
    if p == 0.0 || p == 1.0 {
        n(if trials * p == k { 1.0 } else { 0.0 })
    } else {
        combination(trials, k) * pow(p, k) * pow(1.0 - p, trials - k)
    }
}
pub(super) fn binomial_cdf(x: f64, trials: f64, p: f64) -> N {
    let (mut x, trials, p) = (n(x), n(trials), n(p));
    let eps = 1e-10;
    if x < 0.0 {
        return n(0.0);
    }
    if x >= trials {
        return n(1.0);
    }
    if p < 0.0 || p > 1.0 || trials <= 0.0 {
        return n(f64::NAN);
    }
    x = floor(x);
    let z = p;
    let a = x + 1.0;
    let b = trials - x;
    let s = a + b;
    let bt = exp(gammaln(s) - gammaln(b) - gammaln(a) + a * ln(z) + b * ln(1.0 - z));
    let beta = if z < (a + 1.0) / (s + 2.0) {
        bt * betinc(z, a, b, eps)
    } else {
        1.0 - bt * betinc(1.0 - z, b, a, eps)
    };
    round((1.0 - beta) * (1.0 / eps)) / (1.0 / eps)
}
pub(super) fn negbin_pdf(k: f64, r: f64, p: f64) -> Value {
    if k != f64::from(int32(n(k)) as u32) {
        return Value::Bool(false);
    }
    if k < 0.0 {
        return Value::Number(0.0);
    }
    let (k, r, p) = (n(k), n(r), n(p));
    (combination(k + r - 1.0, r - 1.0) * pow(1.0 - p, k) * pow(p, r)).value()
}
pub(super) fn negbin_cdf(x: f64, r: f64, p: f64) -> N {
    let mut sum = n(0.0);
    if x < 0.0 {
        return sum;
    }
    let mut k = 0.0;
    while k <= x {
        sum += n(to_js_number(&negbin_pdf(k, r, p)));
        k += 1.0;
    }
    sum
}
pub(super) fn poisson_pdf(k: f64, lambda: f64) -> N {
    if lambda < 0.0 || k % 1.0 != 0.0 || k < 0.0 {
        return n(0.0);
    }
    pow(lambda, k) * exp(-lambda) / factorial(n(k))
}
pub(super) fn poisson_cdf(x: f64, lambda: f64) -> N {
    let mut terms = Vec::new();
    if x < 0.0 {
        return n(0.0);
    }
    let mut k = 0.0;
    while k <= x {
        terms.push(poisson_pdf(k, lambda).0);
        k += 1.0;
    }
    n(super::statistical::jsum(&terms))
}
