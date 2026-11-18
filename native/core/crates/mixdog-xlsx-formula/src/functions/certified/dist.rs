//! The continuous worksheet kernels: original worksheet coordinates in, a certified double out. Every argument has
//! passed the worksheet's domain checks (distributions.rs); exact differences (standard scores, distances to the
//! ends of a beta interval) are rationals, everything after them a ball, and only `export` rounds.

use super::ball::{B, exp, expm1, ln};
use super::export::{Val, certified_prob, certified_value};
use super::gammafn::{gamma_signed_log, half_ln_2pi, lgamma};
use super::num::{Fl, Mag};
use super::quad::{Tails, beta_log_mass, beta_tails, gamma_log_mass, gamma_tails};
use super::rat::Rat;
use crate::value::ErrorValue as E;
use std::cmp::Ordering;

type R = Result<f64, E>;

fn half() -> B {
    B::f(0.5)
}

// ---------------------------------------------------------------- normal
/// (Phi(z), 1 - Phi(z)) for a standard score given by its square `z2` (ball) and sign: the outer tail is
/// `Q(1/2, z^2/2)/2`, the inner its complement (at most 1/2, no amplification).
pub(super) fn normal_tails_sq(z2: &B, sign: Ordering) -> (Val, Val) {
    if sign == Ordering::Equal {
        return (Val::Num(half()), Val::Num(half()));
    }
    // Q(1/2, t) at t = z^2/2: vx = ln(t / a) = ln(z^2)
    let t = gamma_tails(&half(), &ln(z2));
    let outer = halve(&t.upper);
    let inner = match &outer {
        Val::Zero => Val::Num(B::one()),
        Val::Num(b) => Val::Num(B::one().sub(b)),
        Val::Log(l) => Val::Num(B::one().sub(&exp(l))),
    };
    if sign == Ordering::Less { (outer, inner) } else { (inner, outer) }
}

pub(super) fn halve(v: &Val) -> Val {
    match v {
        Val::Zero => Val::Zero,
        Val::Num(b) => Val::Num(b.mul_2exp(-1)),
        Val::Log(l) => Val::Log(l.sub(&super::ball::ln2())),
    }
}

fn twice(v: &Val) -> Val {
    match v {
        Val::Zero => Val::Zero,
        Val::Num(b) => Val::Num(b.mul_2exp(1)),
        Val::Log(l) => Val::Log(l.add(&super::ball::ln2())),
    }
}

/// The standard score as an exact rational.
fn score(x: f64, mean: f64, sd: f64) -> Rat {
    Rat::f(x).sub(&Rat::f(mean)).div(&Rat::f(sd))
}

pub fn norm_cdf(x: f64, mean: f64, sd: f64) -> R {
    let z = score(x, mean, sd);
    certified_prob(|| normal_tails_sq(&z.mul(&z).ball(), z.sign()).0)
}

/// 1 - Phi(z) for a score given exactly by its square and sign (Z.TEST).
pub fn norm_upper_sq(z2: &Rat, sign: Ordering) -> R {
    certified_prob(|| normal_tails_sq(&z2.ball(), sign).1)
}

/// Excel's density rule: `#NUM!` when the square of the standard score (as a double) is not finite.
pub fn score_square_overflows(x: f64, mean: f64, sd: f64) -> bool {
    let z = score(x, mean, sd).to_f64();
    !(z * z).is_finite()
}

/// GAUSS(z) = Phi(z) - 1/2 = sign(z) P(1/2, z^2/2) / 2.
pub fn gauss(z: f64) -> R {
    if z == 0.0 {
        return Ok(0.0);
    }
    certified_prob(|| {
        let zz = B::f(z);
        let p = halve(&gamma_tails(&half(), &ln(&zz.sqr())).lower);
        if z < 0.0 { neg(&p) } else { p }
    })
}

fn neg(v: &Val) -> Val {
    match v {
        Val::Zero => Val::Zero,
        Val::Num(b) => Val::Num(b.neg()),
        Val::Log(l) => Val::Num(exp(l).neg()),
    }
}

/// The normal density in log form: -z^2/2 - ln sqrt(2 pi) - ln sd.
pub fn norm_pdf(x: f64, mean: f64, sd: f64) -> R {
    let z = score(x, mean, sd);
    certified_value(|| Val::Log(z.mul(&z).ball().mul_2exp(-1).neg().sub(&half_ln_2pi()).sub(&ln(&B::f(sd)))))
}

pub fn lognorm_cdf(x: f64, mean: f64, sd: f64) -> R {
    certified_prob(|| {
        let z = ln(&B::f(x)).sub(&B::f(mean)).div(&B::f(sd));
        match z.cmp_zero() {
            Some(s) => normal_tails_sq(&z.sqr(), s).0,
            None => Val::Num(B::whole()),
        }
    })
}

pub fn lognorm_pdf(x: f64, mean: f64, sd: f64) -> R {
    certified_value(|| {
        let lx = ln(&B::f(x));
        let z = lx.sub(&B::f(mean)).div(&B::f(sd));
        Val::Log(z.sqr().mul_2exp(-1).neg().sub(&half_ln_2pi()).sub(&ln(&B::f(sd))).sub(&lx))
    })
}

// ---------------------------------------------------------------- exponential, Weibull
/// `1 - e^-v` for v = e^lv given by its log: decided by the log alone at the extremes.
fn one_minus_exp_neg(lv: &B) -> Val {
    if lv.lo().cmp(&Fl::from_i64(44)) == Ordering::Greater {
        // v > e^44 > 2^63: e^-v < 2^-(2^63)
        return Val::Num(B { mid: Fl::from_i64(1), rad: Mag::pow2(-(1 << 60)) });
    }
    if lv.hi().cmp(&Fl::from_i64(-800)) == Ordering::Less {
        // v < e^-800: 1 - e^-v in [v (1 - v/2), v]
        return Val::Log(lv.add(&B { mid: Fl::zero(), rad: Mag::pow2(-1000) }));
    }
    let v = exp(lv);
    Val::Num(expm1(&v.neg()).neg())
}

pub fn expon_cdf(x: f64, rate: f64) -> R {
    if x == 0.0 {
        return Ok(0.0);
    }
    certified_prob(|| one_minus_exp_neg(&ln(&B::f(x)).add(&ln(&B::f(rate)))))
}

pub fn expon_pdf(x: f64, rate: f64) -> R {
    let v = Fl::from_f64(x).mul(&Fl::from_f64(rate));
    certified_value(|| {
        let vb = B::exact(v.clone());
        if v.top() > 70 {
            return Val::Zero; // e^-v below 2^-(2^70)
        }
        Val::Log(ln(&B::f(rate)).sub(&vb))
    })
}

pub fn weibull_cdf(x: f64, shape: f64, scale: f64) -> R {
    if x == 0.0 {
        return Ok(0.0);
    }
    certified_prob(|| one_minus_exp_neg(&B::f(shape).mul(&Rat::f(x).div(&Rat::f(scale)).ln())))
}

pub fn weibull_pdf(x: f64, shape: f64, scale: f64) -> R {
    if x == 0.0 {
        // Excel 16.0 (endpoint table): WEIBULL.DIST(0, k, s, FALSE) = 0 for every shape
        return Ok(0.0);
    }
    certified_value(|| {
        let lv = B::f(shape).mul(&Rat::f(x).div(&Rat::f(scale)).ln());
        if lv.lo().cmp(&Fl::from_i64(44)) == Ordering::Greater {
            return Val::Zero; // the density is below e^-(e^44 - ...) ~ 2^-(2^63)
        }
        let v = exp(&lv);
        Val::Log(ln(&B::f(shape)).sub(&ln(&B::f(x))).add(&lv).sub(&v))
    })
}

// ---------------------------------------------------------------- gamma, chi-square
fn gamma_t(x: f64, scale: f64) -> Rat {
    Rat::f(x).div(&Rat::f(scale))
}

/// vx = ln(t / a) from the exact quotient (exactly zero when the cut is the mode).
pub(super) fn gamma_vx(t: &Rat, a: f64) -> B {
    t.div(&Rat::f(a)).ln()
}

pub fn gamma_cdf_tails(x: &Rat, a: f64) -> impl Fn() -> Tails + '_ {
    move || gamma_tails(&B::f(a), &gamma_vx(x, a))
}

pub fn gamma_cdf(x: f64, a: f64, scale: f64, upper: bool) -> R {
    if x == 0.0 {
        return Ok(if upper { 1.0 } else { 0.0 });
    }
    let t = gamma_t(x, scale);
    certified_prob(|| {
        let tt = gamma_cdf_tails(&t, a)();
        if upper { tt.upper } else { tt.lower }
    })
}

pub fn gamma_pdf(x: f64, a: f64, scale: f64) -> R {
    let t = gamma_t(x, scale);
    certified_value(|| {
        Val::Log(gamma_log_mass(&B::f(a), &gamma_vx(&t, a)).sub(&ln(&B::f(x))))
    })
}

/// Chi-square: gamma with shape d/2 and scale 2 (d an exact double).
pub fn chisq_cdf(x: f64, d: f64, upper: bool) -> R {
    gamma_cdf(x, d / 2.0, 2.0, upper)
}

pub fn chisq_pdf(x: f64, d: f64) -> R {
    gamma_pdf(x, d / 2.0, 2.0)
}

/// The upper tail of a chi-square statistic given exactly (CHISQ.TEST), df an integer.
pub fn chisq_upper_rat(stat: &Rat, df: f64) -> R {
    if stat.is_zero() {
        return Ok(1.0);
    }
    let t = stat.mul_2exp(-1);
    certified_prob(|| gamma_cdf_tails(&t, df / 2.0)().upper)
}

// ---------------------------------------------------------------- beta
/// vx = ln(t b / ((1-t) a)) from the exact distances to the ends and the shapes (exactly zero at the mode).
pub(super) fn beta_vx(lo_d: &Rat, hi_d: &Rat, a: f64, b: f64) -> B {
    lo_d.mul(&Rat::f(b)).div(&hi_d.mul(&Rat::f(a))).ln()
}

pub fn beta_cdf(x: f64, a: f64, b: f64, lo: f64, hi: f64) -> R {
    let (dl, dh) = (Rat::f(x).sub(&Rat::f(lo)), Rat::f(hi).sub(&Rat::f(x)));
    if dl.is_zero() {
        return Ok(0.0);
    }
    if dh.is_zero() {
        return Ok(1.0);
    }
    certified_prob(|| {
        let (ab, bb) = (B::f(a), B::f(b));
        beta_tails(&ab, &bb, &beta_vx(&dl, &dh, a, b)).lower
    })
}

/// The beta density in worksheet units: mass t^a (1-t)^b / B over (x - lo)(hi - x)/(hi - lo).
pub fn beta_pdf(x: f64, a: f64, b: f64, lo: f64, hi: f64) -> R {
    let (dl, dh) = (Rat::f(x).sub(&Rat::f(lo)), Rat::f(hi).sub(&Rat::f(x)));
    let w = Rat::f(hi).sub(&Rat::f(lo));
    certified_value(|| {
        let (ab, bb) = (B::f(a), B::f(b));
        let m = beta_log_mass(&ab, &bb, &beta_vx(&dl, &dh, a, b));
        Val::Log(m.sub(&ln(&dl.ball())).sub(&ln(&dh.ball())).add(&ln(&w.ball())))
    })
}

// ---------------------------------------------------------------- Student t
/// P(|T| > |t|) = I_{d/(d+t^2)}(d/2, 1/2) at vx = -ln(t^2), for t^2 given exactly and df as a ball.
pub(super) fn t_two_sided(t2: &Rat, df: &B) -> Val {
    if t2.is_zero() {
        return Val::Num(B::one());
    }
    beta_tails(&df.mul_2exp(-1), &half(), &t2.ln().neg()).lower
}

fn rat_sq(x: f64) -> Rat {
    Rat::f(x).mul(&Rat::f(x))
}

/// T.DIST cumulative: the outer tail is half the two-sided one, the inner its complement.
pub fn t_cdf(x: f64, d: f64) -> R {
    if x == 0.0 {
        return Ok(0.5);
    }
    let t2 = rat_sq(x);
    certified_prob(|| {
        let outer = halve(&t_two_sided(&t2, &B::f(d)));
        if x < 0.0 { outer } else { complement(&outer) }
    })
}

pub(super) fn complement(v: &Val) -> Val {
    match v {
        Val::Zero => Val::Num(B::one()),
        Val::Num(b) => Val::Num(B::one().sub(b)),
        Val::Log(l) => Val::Num(B::one().sub(&exp(l))),
    }
}

/// The right tail P(T > x) (either sign of x).
pub fn t_rt(x: f64, d: f64) -> R {
    if x == 0.0 {
        return Ok(0.5);
    }
    let t2 = rat_sq(x);
    certified_prob(|| {
        let outer = halve(&t_two_sided(&t2, &B::f(d)));
        if x > 0.0 { outer } else { complement(&outer) }
    })
}

/// `tails` times the one-sided tail beyond |t| for t^2 and df given exactly (T.TEST, TDIST).
pub fn t_tail_rat(t2: &Rat, df: &Rat, tails: i64) -> R {
    certified_prob(|| {
        let two = t_two_sided(t2, &df.ball());
        if tails == 2 { two } else { halve(&two) }
    })
}

pub fn t_2t(x: f64, d: f64) -> R {
    certified_prob(|| t_two_sided(&rat_sq(x), &B::f(d)))
}

/// The t density: the beta mass at vx = -ln t^2 over |t|; at zero 1/(sqrt(d) B(d/2, 1/2)).
pub fn t_pdf(x: f64, d: f64) -> R {
    certified_value(|| {
        let db = B::f(d);
        let a = db.mul_2exp(-1);
        if x == 0.0 {
            let lb = lgamma(&a).add(&lgamma(&half())).sub(&lgamma(&a.add(&half())));
            return Val::Log(ln(&db).mul_2exp(-1).add(&lb).neg());
        }
        let t2 = rat_sq(x).ball();
        Val::Log(beta_log_mass(&a, &half(), &ln(&t2).neg()).sub(&ln(&t2).mul_2exp(-1)))
    })
}

// ---------------------------------------------------------------- F
/// (lower, upper) of F(d1, d2) at x: beta(d1/2, d2/2) at vx = ln x.
pub fn f_cdf(x: f64, d1: f64, d2: f64, upper: bool) -> R {
    certified_prob(|| {
        let t = beta_tails(&B::f(d1 / 2.0), &B::f(d2 / 2.0), &ln(&B::f(x)));
        if upper { t.upper } else { t.lower }
    })
}


/// F.TEST's two-sided probability 2 min(lower, upper) (at most 1 since the tails sum to 1), doubled before
/// rounding; the two tails are compared by their enclosures (when they overlap both are within their radii
/// of 1/2 and either serves).
pub fn f_test_p(f: &Rat, d1: f64, d2: f64) -> R {
    certified_prob(|| {
        let t = beta_tails(&B::f(d1 / 2.0), &B::f(d2 / 2.0), &f.ln());
        let as_ball = |v: &Val| match v {
            Val::Zero => B::zero(),
            Val::Num(b) => b.clone(),
            Val::Log(l) => exp(l),
        };
        let lower_smaller = as_ball(&t.lower).mid.cmp(&as_ball(&t.upper).mid) != Ordering::Greater;
        twice(if lower_smaller { &t.lower } else { &t.upper })
    })
}

pub fn f_pdf(x: f64, d1: f64, d2: f64) -> R {
    certified_value(|| {
        let lx = ln(&B::f(x));
        Val::Log(beta_log_mass(&B::f(d1 / 2.0), &B::f(d2 / 2.0), &lx).sub(&lx))
    })
}

/// `z s / sqrt(n)` rounded once (CONFIDENCE.NORM / CONFIDENCE.T): `#NUM!` beyond the double range.
pub fn scaled_by_root(z: f64, s: f64, n: f64) -> R {
    certified_value(|| Val::Num(B::f(z).mul(&B::f(s)).div(&super::ball::sqrt(&B::f(n)))))
}

// ---------------------------------------------------------------- gamma function
/// GAMMA(x): `#NUM!` at a pole or beyond the double range; Excel's flush to zero below DBL_MIN.
pub fn gamma(x: f64) -> R {
    let negative = gamma_signed_log(x).ok_or(E::Num)?.0;
    let v = super::export::certify(|| Val::Log(gamma_signed_log(x).expect("not a pole").1));
    let m = super::export::prob(&v)?;
    Ok(if negative { -m } else { m })
}

/// GAMMALN(x), x > 0.
pub fn gammaln(x: f64) -> R {
    certified_value(|| Val::Num(lgamma(&B::f(x))))
}

