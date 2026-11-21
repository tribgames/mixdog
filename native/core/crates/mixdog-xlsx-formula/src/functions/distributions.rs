//! Statistical distribution wrappers from formulajs 4.6.1, including legacy
//! aliases and its type/error-order quirks. The inverse distributions add the
//! spreadsheet domain checks (#NUM!) the library lacks; legacy names with their
//! own signature (NORMSDIST, CHIDIST, FDIST, TINV...) follow the legacy function.
//! Copyright (c) 2014 Sutoiku, Inc., MIT; notice in office-stats-distributions.
// Preserve source-indexed/ragged matrix loops and NaN-sensitive comparisons.
#![allow(clippy::needless_range_loop, clippy::manual_range_contains)]
use super::certified::discrete as cd2;
use super::certified::dist as cd;
use super::certified::inverse as ci;
use super::certified::rat::Rat;
use super::jstat::{self as j, N};
use crate::coerce::{flatten, parse_number};
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
fn arg(a: &[V], i: usize) -> V {
    a.get(i).cloned().unwrap_or(V::Undefined)
}
fn default(a: &[V], i: usize, value: V) -> V {
    match a.get(i) {
        None | Some(V::Undefined) => value,
        Some(v) => v.clone(),
    }
}
fn numeric(v: &V) -> Result<f64, E> {
    match parse_number(v) {
        V::Number(n) => Ok(n),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
fn nums(a: &[V], count: usize) -> Result<Vec<f64>, E> {
    (0..count).map(|i| numeric(&arg(a, i))).collect()
}
/// A range's cells in order, `Some` for a number and `None` for text, a logical or a blank (Excel ignores those,
/// pairing them out in the paired T.TEST); an error cell is the result, the first in reading order.
fn cells(v: &V) -> Result<Vec<Option<f64>>, E> {
    flatten(std::slice::from_ref(v))
        .into_iter()
        .map(|x| match x {
            V::Number(n) => Ok(Some(n)),
            V::Error(e) => Err(e),
            _ => Ok(None),
        })
        .collect()
}
fn error(e: E) -> Result<V, Failure> {
    Ok(V::Error(e))
}
/// The cumulative flag at `i`: required (an omitted one is `#VALUE!`, not FALSE), and a logical,
/// a number or numeric text; anything else is `#VALUE!`, not JavaScript truthiness.
fn flag(a: &[V], i: usize) -> Result<bool, E> {
    match a.get(i) {
        None | Some(V::Undefined) => Err(E::Value),
        Some(V::Error(e)) => Err(*e),
        Some(V::Bool(b)) => Ok(*b),
        Some(V::Number(x)) => Ok(*x != 0.0),
        Some(v @ V::Text(_)) => match parse_number(v) {
            V::Number(x) => Ok(x != 0.0),
            _ => Err(E::Value),
        },
        Some(_) => Err(E::Value),
    }
}
macro_rules! flag {
    ($a:expr, $i:expr) => {
        match flag($a, $i) {
            Ok(f) => f,
            Err(e) => return error(e),
        }
    };
}
/// The numbers of an array or range. Excel's rule for the statistical functions that take ranges (Z.TEST, F.TEST,
/// PROB, T.TEST, CHISQ.TEST): text, logicals and blanks in a range are ignored, but an error value in a range is the
/// result of the function (the first one, scanning the first range before the second).
fn numbers_only(v: &V) -> Result<Vec<f64>, E> {
    let mut out = Vec::new();
    for x in flatten(std::slice::from_ref(v)) {
        match x {
            V::Number(n) => out.push(n),
            V::Error(e) => return Err(e),
            _ => {}
        }
    }
    Ok(out)
}
macro_rules! numbers {
    ($v:expr) => {
        match numbers_only($v) {
            Ok(v) => v,
            Err(e) => return error(e),
        }
    };
}
/// Student's t arguments Excel accepts: 1 to 10^10 degrees of freedom, and an `x` whose square is finite (Excel
/// answers `#NUM!` from 1.35E154 on, the square root of the largest double).
fn t_arguments_valid(x: f64, d: f64) -> bool {
    (1.0..=1e10).contains(&d) && (x * x).is_finite()
}
/// Excel 16.0 build 20527 answers an error for the quantile of a one-tail probability (`p` of T.INV, `p/2` of
/// T.INV.2T and TINV) at the bottom of the double range: the smallest probability probed that answers is
/// 2.22507385850721E-308, and the next double above DBL_MIN, 2.2250738585072019E-308, already fails (T.INV(2.226E-308,3)
/// = -3.67E+102 but T.INV(2.2250738585072019E-308,3) is #NUM!); zero and the subnormals fail the same way. The error is
/// #DIV/0! at one degree of freedom and #NUM! from two on (T.INV(0,1), T.INV(1E-308,1), T.INV.2T(4E-308,1) are #DIV/0!;
/// the same arguments at 2, 3, 4, 5, 8, 10 and 30 degrees are #NUM!). The one exception seen, T.INV(1E-320,1) = 0, is not
/// reproduced.
const T_INV_MIN_TAIL: f64 = 2.22507385850721e-308;
fn t_tiny_tail_error(d: f64) -> E {
    if d == 1.0 { E::Div0 } else { E::Num }
}
fn value(x: impl Into<N>) -> Result<V, Failure> {
    Ok(x.into().value())
}
/// A certified kernel's double, or its error (`#NUM!` beyond the double range).
fn cert(r: Result<f64, E>) -> Result<V, Failure> {
    Ok(match r {
        Ok(x) => V::Number(x),
        Err(e) => V::Error(e),
    })
}
macro_rules! parsed {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return error(e),
        }
    };
}
/// The argument kinds of each scalar-argument function, in order (`n` number, `f` the required cumulative flag, `o` an
/// optional number). Excel (16.0 build 20527, probed with competing errors such as `BINOM.DIST(1/0,10,0.5,NA())`
/// = #DIV/0!, `BINOM.DIST(-1,10,0.5,"abc")` = #VALUE!, `BINOM.DIST("x",10,0.5,NA())` = #VALUE!) reads the arguments
/// left to right: the first one that is an error value or cannot be coerced decides, before any domain check.
const ARGUMENT_KINDS: &[(&str, &str)] = &[
    ("BETA.DIST", "nnnfoo"),
    ("BETA.INV", "nnnoo"),
    ("BINOM.DIST", "nnnf"),
    ("BINOM.DIST.RANGE", "nnno"),
    ("BINOM.INV", "nnn"),
    ("CHISQ.DIST", "nnf"),
    ("CHISQ.DIST.RT", "nn"),
    ("CHISQ.INV", "nn"),
    ("CHISQ.INV.RT", "nn"),
    ("CONFIDENCE.NORM", "nnn"),
    ("CONFIDENCE.T", "nnn"),
    ("EXPON.DIST", "nnf"),
    ("F.DIST", "nnnf"),
    ("F.DIST.RT", "nnn"),
    ("F.INV", "nnn"),
    ("F.INV.RT", "nnn"),
    ("GAMMA", "n"),
    ("GAMMALN", "n"),
    ("GAUSS", "n"),
    ("GAMMALN.PRECISE", "n"),
    ("GAMMA.DIST", "nnnf"),
    ("GAMMA.INV", "nnn"),
    ("HYPGEOM.DIST", "nnnnf"),
    ("LOGNORM.DIST", "nnnf"),
    ("LOGNORM.INV", "nnn"),
    ("NEGBINOM.DIST", "nnnf"),
    ("NORM.DIST", "nnnf"),
    ("NORM.INV", "nnn"),
    ("NORM.S.DIST", "nf"),
    ("NORM.S.INV", "n"),
    ("PHI", "n"),
    ("POISSON.DIST", "nnf"),
    ("T.DIST", "nnf"),
    ("TDIST", "nnn"),
    ("T.DIST.RT", "nn"),
    ("T.DIST.2T", "nn"),
    ("T.INV", "nn"),
    ("T.INV.2T", "nn"),
    ("WEIBULL.DIST", "nnnf"),
];
fn scan_arguments(name: &str, a: &[V]) -> Result<(), E> {
    let Some((_, kinds)) = ARGUMENT_KINDS.iter().find(|(n, _)| *n == name) else {
        return Ok(());
    };
    for (i, kind) in kinds.chars().enumerate().take(a.len()) {
        match kind {
            'f' => {
                flag(a, i)?;
            }
            'o' if matches!(a[i], V::Undefined) => {}
            _ => {
                numeric(&a[i])?;
            }
        }
    }
    Ok(())
}
fn eval_beta_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(&[arg(a, 0), arg(a, 1), arg(a, 2), default(a, 4, V::Number(0.0)), default(a, 5, V::Number(1.0))], 5));
    if p[1] <= 0.0 || p[2] <= 0.0 || p[0] < p[3] || p[0] > p[4] || p[3] == p[4] {
        return error(E::Num);
    }
    if !cumulative {
        // Excel 16.0 build 20527 judges the density at an end on the argument itself, not the scaled one:
        // #NUM! when x = 0 and a <= 1 or x = 1 and b <= 1 (also strictly inside a scaled interval), and 0
        // at the ends of the interval otherwise (BETA.DIST(5,1,1,FALSE,5,10) = 0, (0,1,1,FALSE,0,1) = #NUM!)
        if (p[0] == 0.0 && p[1] <= 1.0) || (p[0] == 1.0 && p[2] <= 1.0) {
            return error(E::Num);
        }
        if p[0] == p[3] || p[0] == p[4] {
            return value(0.0);
        }
    }
    // the kernels take the worksheet x and both ends: the two distances are exact
    cert(if cumulative { cd::beta_cdf(p[0], p[1], p[2], p[3], p[4]) } else { cd::beta_pdf(p[0], p[1], p[2], p[3], p[4]) })
}
fn eval_beta_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(&[arg(a, 0), arg(a, 1), arg(a, 2), default(a, 3, V::Number(0.0)), default(a, 4, V::Number(1.0))], 5));
    let q = flush(p[0]);
    if q <= 0.0 || q >= 1.0 || p[1] <= 0.0 || p[2] <= 0.0 || p[3] >= p[4] {
        return error(E::Num);
    }
    // the search runs on the worksheet x in [A, B] itself, never a rescaled unit quantile
    let guess = estimate(j::beta_inv(q, p[1], p[2])).map(|u| p[3] * (1.0 - u) + p[4] * u);
    let law = ci::Law::Beta { a: p[1], b: p[2], lo: p[3], hi: p[4] };
    cert(ci::quantile(law, &ci::Target::lower(q), p[3], p[4], guess))
}
fn eval_binom_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    let p = [p[0].trunc(), p[1].trunc(), p[2]];
    // Excel: at most 10^10 trials (BINOM.DIST(5,10000000001,0.5,TRUE) is #NUM!).
    if p[0] < 0.0 || p[0] > p[1] || p[1] > 1e10 || p[2] < 0.0 || p[2] > 1.0 {
        return error(E::Num);
    }
    // Excel: the mass of no successes when every trial succeeds is #NUM! (BINOM.DIST(0,10,1,FALSE)), unlike
    // BINOM.DIST(0,0,1,FALSE) = 1
    if !cumulative && p[0] == 0.0 && p[1] > 0.0 && p[2] == 1.0 {
        return error(E::Num);
    }
    cert(if cumulative { cd2::binom_cdf(p[0], p[1], p[2], false) } else { cd2::binom_pmf(p[0], p[1], p[2]) })
}
fn eval_binom_dist_range(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(&[arg(a, 0), arg(a, 1), arg(a, 2), default(a, 3, arg(a, 2))], 4));
    let p = [p[0].trunc(), p[1], p[2].trunc(), p[3].trunc()];
    if p[0] < 0.0 || p[1] < 0.0 || p[1] > 1.0 || p[2] < 0.0 || p[2] > p[0] || p[3] < p[2] || p[3] > p[0] {
        return error(E::Num);
    }
    // Excel: #NUM! from 2^31-1 trials upward (probed: 2147483646 answers, 2147483647 does not).
    if p[0] >= 2_147_483_647.0 {
        return error(E::Num);
    }
    cert(cd2::binom_range(p[0], p[1], p[2], p[3]))
}
fn eval_binom_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 3));
    let trials = p[0].trunc();
    // Excel: #NUM! from 2^31-1 trials upward, as for BINOM.DIST.RANGE.
    if trials < 0.0 || trials >= 2_147_483_647.0 || p[1] <= 0.0 || p[1] >= 1.0 || p[2] <= 0.0 || p[2] >= 1.0 {
        return error(E::Num);
    }
    // the smallest count with P(X <= x) >= alpha: a double-precision estimate (the earlier bisection on the
    // double kernels) accepted only when the certified comparisons at it and below it agree, else a
    // certified integer bisection
    let alpha = flush(p[2]);
    if alpha <= 0.0 {
        return error(E::Num);
    }
    let (mut lo, mut hi) = (0.0_f64, trials);
    let mut ok = true;
    while lo < hi && ok {
        let mid = lo + ((hi - lo) / 2.0).floor();
        match j::binomial_tails(mid, trials, p[1]) {
            Ok(t) => {
                if if alpha > 0.5 { t.1 <= 1.0 - alpha } else { t.0 >= alpha } {
                    hi = mid;
                } else {
                    lo = mid + 1.0;
                }
            }
            Err(_) => ok = false,
        }
    }
    cert(cd2::binom_inv(trials, p[1], alpha, ok.then_some(lo)))
}
fn eval_chisq_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 2);
    let p = parsed!(nums(a, 2));
    let p = [p[0], p[1].trunc()];
    if p[0] < 0.0 || p[1] < 1.0 || p[1] > 1e10 {
        return error(E::Num);
    }
    if cumulative {
        cert(cd::chisq_cdf(p[0], p[1], false))
    } else if p[0] == 0.0 {
        // Excel: CHISQ.DIST(0,1,FALSE) is #NUM!, (0,2,FALSE) = 0.5, 0 from three degrees on
        if p[1] < 2.0 { error(E::Num) } else { value(if p[1] == 2.0 { 0.5 } else { 0.0 }) }
    } else {
        cert(cd::chisq_pdf(p[0], p[1]))
    }
}
fn eval_chisq_dist_rt(a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 2));
    let (x, d) = (p[0], p[1].trunc());
    if x < 0.0 || d < 1.0 || d > 1e10 {
        return error(E::Num);
    }
    cert(cd::chisq_cdf(x, d, true))
}
fn eval_chisq_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 2));
    let (q, d) = (flush(p[0]), p[1].trunc());
    // p = 1 is the singular endpoint (an infinite quantile).
    if q < 0.0 || q >= 1.0 || d < 1.0 || d > 1e10 {
        return error(E::Num);
    }
    if q == 0.0 {
        return value(0.0);
    }
    let law = ci::Law::Gamma { a: d / 2.0, scale: 2.0 };
    let guess = estimate(j::chisquare_inv(q, d)).or_else(|| gamma_guess(q, d / 2.0, 2.0)).or_else(|| gamma_far_tail_guess(q, d / 2.0, 2.0));
    cert(ci::quantile(law, &ci::Target::lower(q), 0.0, f64::MAX, guess))
}
fn eval_chisq_inv_rt(a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 2));
    let (q, d) = (flush(p[0]), p[1].trunc());
    // Unlike the other chi-square functions, Excel has no upper limit here (CHIINV(0.5,1E15) answers).
    if q <= 0.0 || q > 1.0 || d < 1.0 {
        return error(E::Num);
    }
    if q == 1.0 {
        return value(0.0);
    }
    let law = ci::Law::Gamma { a: d / 2.0, scale: 2.0 };
    let guess = estimate(j::chisquare_inv_rt(q, d)).or_else(|| gamma_guess(1.0 - q, d / 2.0, 2.0));
    cert(ci::quantile(law, &ci::Target::upper(q), 0.0, f64::MAX, guess))
}
fn eval_confidence(name: &str, a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 3));
    let (alpha, size) = (flush(p[0]), p[2].trunc());
    if alpha <= 0.0 || alpha >= 1.0 || p[1] <= 0.0 || size < 1.0 {
        return error(E::Num);
    }
    if name == "CONFIDENCE.T" && size == 1.0 {
        return error(E::Div0);
    }
    // the critical value of the two-sided level alpha (P(|Z| > z) = alpha), then scale z / sqrt(n) rounded
    // once
    let z = if name == "CONFIDENCE.NORM" {
        let law = ci::Law::Normal { mean: 0.0, sd: 1.0 };
        let guess = j::normal_inv(1.0 - alpha / 2.0, 0.0, 1.0).0;
        ci::quantile(law, &ci::Target::upper(alpha / 2.0), 0.0, f64::MAX, Some(guess))
    } else {
        let law = ci::Law::T2 { d: size - 1.0 };
        ci::quantile(law, &ci::Target::upper(alpha), 0.0, f64::MAX, estimate(j::student_inv_2t(alpha, size - 1.0)))
    };
    cert(z.and_then(|z| cd::scaled_by_root(z, p[1], size)))
}
fn eval_expon_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 2);
    let p = parsed!(nums(a, 2));
    if p[0] < 0.0 || p[1] <= 0.0 {
        return error(E::Num);
    }
    cert(if cumulative { cd::expon_cdf(p[0], p[1]) } else { cd::expon_pdf(p[0], p[1]) })
}
fn eval_f_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    let p = [p[0], p[1].trunc(), p[2].trunc()];
    // Excel: degrees of freedom of at least one and at most 10^10 (11 digits is #NUM!).
    if p[0] < 0.0 || p[1] < 1.0 || p[2] < 1.0 || p[1] > 1e10 || p[2] > 1e10 {
        return error(E::Num);
    }
    if cumulative {
        if p[0] == 0.0 {
            return value(0.0);
        }
        cert(cd::f_cdf(p[0], p[1], p[2], false))
    } else if p[0] == 0.0 {
        // Excel: #NUM! at one numerator degree, 1 at two, 0 from three on
        if p[1] < 2.0 { error(E::Num) } else { value(if p[1] == 2.0 { 1.0 } else { 0.0 }) }
    } else {
        cert(cd::f_pdf(p[0], p[1], p[2]))
    }
}
fn eval_f_right_tail(name: &str, a: &[V]) -> Result<V, Failure> {
    if a.len() != 3 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 3));
    let inverse = name == "F.INV.RT";
    let p = [if inverse { flush(p[0]) } else { p[0] }, p[1].trunc(), p[2].trunc()];
    // Excel: both degrees of freedom from 1 to 10^10 inclusive.
    if (inverse && (p[0] <= 0.0 || p[0] > 1.0)) || (!inverse && p[0] < 0.0) || p[1] < 1.0 || p[2] < 1.0 || p[1] > 1e10 || p[2] > 1e10 {
        return error(E::Num);
    }
    if !inverse {
        if p[0] == 0.0 {
            return value(1.0);
        }
        cert(cd::f_cdf(p[0], p[1], p[2], true))
    } else {
        if p[0] == 1.0 {
            return value(0.0);
        }
        let law = ci::Law::F { d1: p[1], d2: p[2] };
        let guess = estimate(j::central_f_inv_rt(p[0], p[1], p[2]));
        cert(ci::quantile(law, &ci::Target::upper(p[0]), 0.0, f64::MAX, guess))
    }
}
fn eval_f_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 3));
    let p = [flush(p[0]), p[1].trunc(), p[2].trunc()];
    // p = 1 is the singular endpoint (an infinite quantile).
    if p[0] < 0.0 || p[0] >= 1.0 || p[1] < 1.0 || p[2] < 1.0 || p[1] > 1e10 || p[2] > 1e10 {
        return error(E::Num);
    }
    if p[0] == 0.0 {
        return value(0.0);
    }
    let law = ci::Law::F { d1: p[1], d2: p[2] };
    let guess = estimate(j::central_f_inv(p[0], p[1], p[2]));
    cert(ci::quantile(law, &ci::Target::lower(p[0]), 0.0, f64::MAX, guess))
}
fn eval_gamma_functions(name: &str, a: &[V]) -> Result<V, Failure> {
    let x = match numeric(&arg(a, 0)) {
        Ok(x) => x,
        Err(e) => return error(e),
    };
    if name == "GAMMA" {
        cert(cd::gamma(x))
    } else if name == "GAMMALN" {
        if x <= 0.0 {
            return error(E::Num);
        }
        cert(cd::gammaln(x))
    } else {
        // Φ(x) - ½ = sign(x) P(½, x²/2) / 2, without forming the difference
        cert(cd::gauss(x))
    }
}
fn eval_gamma_dist_inv(name: &str, a: &[V]) -> Result<V, Failure> {
    if a.len() != if name == "GAMMA.DIST" { 4 } else { 3 } {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 3));
    let inverse = name == "GAMMA.INV";
    let p = [if inverse { flush(p[0]) } else { p[0] }, p[1], p[2]];
    let cumulative = if inverse { false } else { flag!(a, 3) };
    // GAMMA.INV(1) is the singular endpoint (an infinite quantile).
    if p[0] < 0.0 || p[1] <= 0.0 || p[2] <= 0.0 || (inverse && p[0] >= 1.0) {
        return error(E::Num);
    }
    if inverse {
        if p[0] == 0.0 {
            return value(0.0);
        }
        let law = ci::Law::Gamma { a: p[1], scale: p[2] };
        // the estimate in unit scale, then scaled: at a scale of DBL_MIN the scaled estimate underflowed to
        // 0 and the search bisected the whole range (GAMMA.INV(0.5,1,2.2250738585072014E-308), 2.7 s)
        let guess = estimate(j::gamma_inv(p[0], p[1], 1.0).map(|t| t * p[2]))
            .or_else(|| gamma_guess(p[0], p[1], p[2]))
            .or_else(|| gamma_far_tail_guess(p[0], p[1], p[2]));
        cert(ci::quantile(law, &ci::Target::lower(p[0]), 0.0, f64::MAX, guess))
    } else if cumulative {
        cert(cd::gamma_cdf(p[0], p[1], p[2], false))
    } else if p[0] == 0.0 {
        // Excel: #NUM! at x = 0 for shapes up to 1 (GAMMA.DIST(0,1,2,FALSE) included), 0 above
        if p[1] <= 1.0 { error(E::Num) } else { value(0.0) }
    } else {
        cert(cd::gamma_pdf(p[0], p[1], p[2]))
    }
}
fn eval_gammaln_precise(a: &[V]) -> Result<V, Failure> {
    if a.len() != 1 {
        return error(E::Na);
    }
    let x = parsed!(numeric(&a[0]));
    if x <= 0.0 {
        return error(E::Num);
    }
    cert(cd::gammaln(x))
}
fn eval_hypgeom_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 4);
    let p = parsed!(nums(a, 4));
    let p = [p[0].trunc(), p[1].trunc(), p[2].trunc(), p[3].trunc()];
    let (sample_s, sample, pop_s, pop) = (p[0], p[1], p[2], p[3]);
    // Excel: only negative counts, a sample larger than the population and more successes than the
    // population are #NUM!; a count outside the support is a mass of 0 (and a cumulative of 0 below, 1 above)
    if sample_s < 0.0 || sample < 0.0 || pop_s < 0.0 || pop < 0.0 || sample > pop || pop_s > pop {
        return error(E::Num);
    }
    let lowest = (sample - pop + pop_s).max(0.0);
    let highest = sample.min(pop_s);
    if pop == 0.0 {
        return value(1.0);
    }
    if sample_s < lowest {
        return value(0.0);
    }
    if sample_s > highest {
        return value(if cumulative { 1.0 } else { 0.0 });
    }
    if cumulative && sample_s == highest {
        return value(1.0);
    }
    // exact counts: the kernels never step a floating index
    cert(if cumulative { cd2::hypgeom_cdf(p[0], p[1], p[2], p[3]) } else { cd2::hypgeom_pmf(p[0], p[1], p[2], p[3]) })
}
fn eval_lognorm_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    if p[0] <= 0.0 || p[2] <= 0.0 {
        return error(E::Num);
    }
    if cumulative {
        return cert(cd::lognorm_cdf(p[0], p[1], p[2]));
    }
    // Excel 16.0: a variance below DBL_MIN is #DIV/0! (LOGNORM.DIST(2,0,1E-155,FALSE)), then the score
    // square rule (LOGNORM.DIST(1E300,0,1E-152,FALSE) = #NUM!)
    if p[2] * p[2] < f64::MIN_POSITIVE {
        return error(E::Div0);
    }
    let z = (p[0].ln() - p[1]) / p[2];
    if !(z * z).is_finite() {
        return error(E::Num);
    }
    cert(cd::lognorm_pdf(p[0], p[1], p[2]))
}
fn eval_lognorm_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 3));
    let q = flush(p[0]);
    if q <= 0.0 || q >= 1.0 || p[2] <= 0.0 {
        return error(E::Num);
    }
    let law = ci::Law::LogNormal { mean: p[1], sd: p[2] };
    let guess = j::lognormal_inv(q, p[1], p[2]).0;
    cert(ci::quantile(law, &ci::Target::lower(q), 0.0, f64::MAX, Some(guess)))
}
fn eval_negbinom_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    let p = [p[0].trunc(), p[1].trunc(), p[2]];
    // Excel: the success probability is strictly between 0 and 1 (p = 0 and p = 1 are #NUM! in both forms)
    if p[0] < 0.0 || p[1] < 1.0 || p[2] <= 0.0 || p[2] >= 1.0 {
        return error(E::Num);
    }
    cert(if cumulative { cd2::negbin_cdf(p[0], p[1], p[2]) } else { cd2::negbin_pmf(p[0], p[1], p[2]) })
}
fn eval_norm_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    if p[2] <= 0.0 {
        return error(E::Num);
    }
    normal_dist(p[0], p[1], p[2], cumulative)
}
fn eval_norm_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 3));
    let q = flush(p[0]);
    if q <= 0.0 || q >= 1.0 || p[2] <= 0.0 {
        return error(E::Num);
    }
    normal_inv(q, p[1], p[2])
}
fn eval_norm_s_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 1);
    let p = parsed!(nums(a, 1));
    normal_dist(p[0], 0.0, 1.0, cumulative)
}
fn eval_norm_s_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 1));
    let q = flush(p[0]);
    if q <= 0.0 || q >= 1.0 {
        return error(E::Num);
    }
    normal_inv(q, 0.0, 1.0)
}
fn eval_phi(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 1));
    normal_dist(p[0], 0.0, 1.0, false)
}
fn eval_poisson_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 2);
    let p = parsed!(nums(a, 2));
    let p = [p[0].trunc(), p[1]];
    if p[0] < 0.0 || p[1] < 0.0 {
        return error(E::Num);
    }
    cert(if cumulative { cd2::poisson_cdf(p[0], p[1]) } else { cd2::poisson_pmf(p[0], p[1]) })
}
fn eval_t_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 2);
    let p = parsed!(nums(a, 2));
    let d = p[1].trunc();
    // Excel: a density with fewer than one degree of freedom is #DIV/0! (a negative count #NUM!), the
    // cumulative form #NUM!
    if !cumulative && d == 0.0 && p[1] >= 0.0 {
        return error(E::Div0);
    }
    if !t_arguments_valid(p[0], d) {
        return error(E::Num);
    }
    cert(if cumulative { cd::t_cdf(p[0], d) } else { cd::t_pdf(p[0], d) })
}
/// The legacy TDIST(x, df, tails): x is not negative and the third argument counts tails.
fn eval_tdist(a: &[V]) -> Result<V, Failure> {
    if a.len() != 3 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 3));
    let (d, tails) = (p[1].trunc(), p[2].trunc());
    if p[0] < 0.0 || !t_arguments_valid(p[0], d) || (tails != 1.0 && tails != 2.0) {
        return error(E::Num);
    }
    cert(if tails == 2.0 { cd::t_2t(p[0], d) } else { cd::t_rt(p[0], d) })
}
fn eval_t_dist_tails(name: &str, a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 2));
    let (x, d) = (p[0], p[1].trunc());
    let two = name == "T.DIST.2T";
    if (two && x < 0.0) || !t_arguments_valid(x, d) {
        return error(E::Num);
    }
    cert(if two { cd::t_2t(x, d) } else { cd::t_rt(x, d) })
}
fn eval_t_inv(a: &[V]) -> Result<V, Failure> {
    let p = parsed!(nums(a, 2));
    let d = p[1].trunc();
    if p[0] < 0.0 || p[0] >= 1.0 || !t_arguments_valid(0.0, d) {
        return error(E::Num);
    }
    if p[0] < T_INV_MIN_TAIL {
        return error(t_tiny_tail_error(d));
    }
    let guess = estimate(j::student_inv(p[0], d));
    cert(ci::quantile(ci::Law::T { d }, &ci::Target::lower(p[0]), -f64::MAX, f64::MAX, guess))
}
fn eval_t_inv_2t(a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let p = parsed!(nums(a, 2));
    let d = p[1].trunc();
    if p[0] < 0.0 || p[0] > 1.0 || !t_arguments_valid(0.0, d) {
        return error(E::Num);
    }
    if p[0] / 2.0 < T_INV_MIN_TAIL {
        return error(t_tiny_tail_error(d));
    }
    if p[0] == 1.0 {
        return value(0.0);
    }
    // the two-tail quantile P(|T| > x) = p, compared on the tail that is the smaller probability
    let guess = estimate(j::student_inv_2t(p[0], d));
    cert(ci::quantile(ci::Law::T2 { d }, &ci::Target::upper(p[0]), 0.0, f64::MAX, guess))
}
fn eval_weibull_dist(a: &[V]) -> Result<V, Failure> {
    let cumulative = flag!(a, 3);
    let p = parsed!(nums(a, 3));
    if p[0] < 0.0 || p[1] <= 0.0 || p[2] <= 0.0 {
        return error(E::Num);
    }
    cert(if cumulative { cd::weibull_cdf(p[0], p[1], p[2]) } else { cd::weibull_pdf(p[0], p[1], p[2]) })
}
fn eval_z_test(a: &[V]) -> Result<V, Failure> {
    // Text, logicals and blanks in the array are ignored; an empty array is #N/A.
    // Excel reads left to right (the first error in the array, then x, then sigma) and only then tests the array
    // for emptiness (Z.TEST(K1:K3,1/0) is #DIV/0!, Z.TEST(K1:K3,1,1) is #N/A).
    let a0 = numbers!(&arg(a, 0));
    let x = parsed!(numeric(&arg(a, 1)));
    if !matches!(a.get(2), None | Some(V::Undefined)) {
        parsed!(numeric(&arg(a, 2)));
    }
    if a0.is_empty() {
        return error(E::Na);
    }
    // Only an omitted sigma means "use the sample deviation"; an explicit 0 or negative one is #NUM!
    // (Excel: Z.TEST(A1:A4,1,0) and Z.TEST(A1:A4,1,-1)).
    let count = a0.len() as i64;
    let (mean, ss) = mean_and_squares(&a0);
    let diff = mean.sub(&Rat::f(x));
    // z = (mean - x) / (sigma / sqrt(n)) enters as its exact square and sign
    let z2 = if matches!(a.get(2), None | Some(V::Undefined)) {
        if count < 2 {
            return error(E::Div0);
        }
        if ss.is_zero() {
            return error(E::Div0);
        }
        diff.mul(&diff).mul(&Rat::int(count * (count - 1))).div(&ss)
    } else {
        let sigma = parsed!(numeric(&arg(a, 2)));
        if sigma <= 0.0 {
            return error(E::Num);
        }
        diff.mul(&diff).mul(&Rat::int(count)).div(&Rat::f(sigma).mul(&Rat::f(sigma)))
    };
    // the upper tail of the standard normal at z, taken from its own tail
    cert(cd::norm_upper_sq(&z2, diff.sign()))
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    if let Err(e) = scan_arguments(name, a) {
        return error(e);
    }
    match name {
        "BETA.DIST" => eval_beta_dist(a),
        "BETA.INV" => eval_beta_inv(a),
        "BINOM.DIST" => eval_binom_dist(a),
        "BINOM.DIST.RANGE" => eval_binom_dist_range(a),
        "BINOM.INV" => eval_binom_inv(a),
        "CHISQ.DIST" => eval_chisq_dist(a),
        "CHISQ.DIST.RT" => eval_chisq_dist_rt(a),
        "CHISQ.INV" => eval_chisq_inv(a),
        "CHISQ.INV.RT" => eval_chisq_inv_rt(a),
        "CHISQ.TEST" => chisq_test(a),
        "CONFIDENCE.NORM" | "CONFIDENCE.T" => eval_confidence(name, a),
        "EXPON.DIST" => eval_expon_dist(a),
        "F.DIST" => eval_f_dist(a),
        "F.DIST.RT" | "F.INV.RT" => eval_f_right_tail(name, a),
        "F.INV" => eval_f_inv(a),
        "F.TEST" => f_test(a),
        "GAMMA" | "GAMMALN" | "GAUSS" => eval_gamma_functions(name, a),
        "GAMMA.DIST" | "GAMMA.INV" => eval_gamma_dist_inv(name, a),
        "GAMMALN.PRECISE" => eval_gammaln_precise(a),
        "HYPGEOM.DIST" => eval_hypgeom_dist(a),
        "LOGNORM.DIST" => eval_lognorm_dist(a),
        "LOGNORM.INV" => eval_lognorm_inv(a),
        "NEGBINOM.DIST" => eval_negbinom_dist(a),
        "NORM.DIST" => eval_norm_dist(a),
        "NORM.INV" => eval_norm_inv(a),
        "NORM.S.DIST" => eval_norm_s_dist(a),
        "NORM.S.INV" => eval_norm_s_inv(a),
        // Legacy names whose arguments differ from the modern function's: the
        // cumulative flag does not exist and the answer is always cumulative.
        "NORMSDIST" if a.len() != 1 => error(E::Na),
        "NORMSDIST" => run("NORM.S.DIST", &[arg(a, 0), V::Bool(true)]),
        "LOGNORMDIST" if a.len() != 3 => error(E::Na),
        "LOGNORMDIST" => run("LOGNORM.DIST", &[arg(a, 0), arg(a, 1), arg(a, 2), V::Bool(true)]),
        "BETADIST" if !(3..=5).contains(&a.len()) => error(E::Na),
        "BETADIST" => run("BETA.DIST", &[arg(a, 0), arg(a, 1), arg(a, 2), V::Bool(true), arg(a, 3), arg(a, 4)]),
        // Flagless legacy signatures: probability mass only.
        "HYPGEOMDIST" if a.len() != 4 => error(E::Na),
        "HYPGEOMDIST" => run("HYPGEOM.DIST", &[arg(a, 0), arg(a, 1), arg(a, 2), arg(a, 3), V::Bool(false)]),
        "NEGBINOMDIST" if a.len() != 3 => error(E::Na),
        "NEGBINOMDIST" => run("NEGBINOM.DIST", &[arg(a, 0), arg(a, 1), arg(a, 2), V::Bool(false)]),
        // Right-tail and two-tail legacy names answer exactly like the modern function they stand for
        // (checked in Excel 16.0 build 20527: the degrees-of-freedom ceilings are the same).
        "CHIDIST" | "CHIINV" | "FDIST" | "FINV" | "TINV" => run(
            match name {
                "CHIDIST" => "CHISQ.DIST.RT",
                "CHIINV" => "CHISQ.INV.RT",
                "FDIST" => "F.DIST.RT",
                "FINV" => "F.INV.RT",
                _ => "T.INV.2T",
            },
            a,
        ),
        "PHI" => eval_phi(a),
        "POISSON.DIST" => eval_poisson_dist(a),
        "PROB" => prob(a),
        "T.DIST" => eval_t_dist(a),
        "TDIST" => eval_tdist(a),
        "T.DIST.RT" | "T.DIST.2T" => eval_t_dist_tails(name, a),
        "T.INV" => eval_t_inv(a),
        "T.INV.2T" => eval_t_inv_2t(a),
        "T.TEST" => t_test(a),
        "WEIBULL.DIST" => eval_weibull_dist(a),
        "Z.TEST" => eval_z_test(a),
        _ => unreachable!("registered distribution"),
    }
}
/// The double quantile as a starting point for the certified search. A root below the kernels' bracket comes back as
/// 0, which the search rejects (and then bisects the whole range): it is no estimate, so the caller's fallback runs.
fn estimate<E>(root: Result<f64, E>) -> Option<f64> {
    root.ok().filter(|g| *g != 0.0 && g.is_finite())
}
/// A probability argument as Excel reads it: a subnormal is zero (Excel flushes subnormals on entry, see
/// `subnormal_probabilities_are_zero_in_excel_and_in_the_engine`).
fn flush(p: f64) -> f64 {
    if p.abs() < f64::MIN_POSITIVE { 0.0 } else { p }
}
/// A gamma quantile estimate where the double kernels give none (huge shapes): Wilson-Hilferty,
/// `a (1 - 1/(9a) + z/(3 sqrt a))^3` times the scale, z the normal quantile of the lower tail `p`. Only a starting
/// point: the certified search accepts it when the tails at its two probes bracket the target.
fn gamma_guess(p: f64, a: f64, scale: f64) -> Option<f64> {
    let z = super::special::norm_quantile(p);
    let c = 1.0 - 1.0 / (9.0 * a) + z / (3.0 * a.sqrt());
    let x = a * c * c * c * scale;
    (x.is_finite() && x > 0.0).then_some(x)
}
/// A subnormal gamma quantile estimate for a far lower tail `p` (Wilson-Hilferty's `c <= 0`, the cube has left the
/// cube-root's range): `P(a, x) = x^a / Γ(a+1)` to first order. Only a subnormal seed is given: the rank search lands
/// on the nearest double from it, whereas a normal seed that the probes certify is returned unrefined.
fn gamma_far_tail_guess(p: f64, a: f64, scale: f64) -> Option<f64> {
    let c = 1.0 - 1.0 / (9.0 * a) + super::special::norm_quantile(p) / (3.0 * a.sqrt());
    if !(c <= 0.0) {
        return None;
    }
    let x = ((p.ln() + super::special::ln_gamma(a + 1.0)) / a).exp() * scale;
    (x > 0.0 && x < f64::MIN_POSITIVE).then_some(x)
}
/// The normal quantile in worksheet units, searched on the worksheet x itself (a quantile past the largest double
/// is `#NUM!`).
fn normal_inv(p: f64, mean: f64, sd: f64) -> Result<V, Failure> {
    let law = ci::Law::Normal { mean, sd };
    let guess = j::normal_inv(p, mean, sd).0;
    cert(ci::quantile(law, &ci::Target::lower(p), -f64::MAX, f64::MAX, Some(guess)))
}
/// The normal cumulative or density in worksheet coordinates. Excel 16.0: the density is `#NUM!` when the square
/// of the standard score is not a finite double (PHI(1.35E154), NORM.DIST(1E300,0,1,FALSE)); 0 below that.
fn normal_dist(x: f64, mean: f64, sd: f64, cumulative: bool) -> Result<V, Failure> {
    if cumulative {
        return cert(cd::norm_cdf(x, mean, sd));
    }
    if cd::score_square_overflows(x, mean, sd) {
        return error(E::Num);
    }
    cert(cd::norm_pdf(x, mean, sd))
}
fn prob(a: &[V]) -> Result<V, Failure> {
    if matches!(a.get(2), None | Some(V::Undefined)) {
        return error(E::Value);
    }
    let x = numbers!(&arg(a, 0));
    let p = numbers!(&arg(a, 1));
    let lo = parsed!(numeric(&arg(a, 2)));
    let hi = parsed!(numeric(&default(a, 3, arg(a, 2))));
    if x.len() != p.len() || x.is_empty() {
        return error(E::Na);
    }
    // Every probability is in (0, 1] and they sum to 1 (within floating-point rounding).
    if p.iter().any(|v| *v <= 0.0 || *v > 1.0) || (p.iter().sum::<f64>() - 1.0).abs() > 1e-9 {
        return error(E::Num);
    }
    // With no upper limit it is P(X = lower); otherwise P(lower <= X <= upper).
    let (lo, hi) = if matches!(a.get(3), None | Some(V::Undefined)) { (lo, lo) } else { (lo, hi) };
    value(x.iter().zip(&p).filter(|(v, _)| **v >= lo && **v <= hi).fold(0.0, |total, (_, q)| total + *q))
}
fn f_test(a: &[V]) -> Result<V, Failure> {
    // Text, logicals and blanks are ignored; fewer than two numbers or a zero variance is #DIV/0!.
    let x = numbers!(&arg(a, 0));
    let y = numbers!(&arg(a, 1));
    if x.len() < 2 || y.len() < 2 {
        return error(E::Div0);
    }
    let (sx, sy) = (mean_and_squares(&x).1, mean_and_squares(&y).1);
    if sx.is_zero() || sy.is_zero() {
        return error(E::Div0);
    }
    // The two-tailed probability that the variances are not significantly different; the ratio is exact.
    let (dx, dy) = (x.len() as i64 - 1, y.len() as i64 - 1);
    let f = sx.div(&Rat::int(dx)).div(&sy.div(&Rat::int(dy)));
    cert(cd::f_test_p(&f, dx as f64, dy as f64))
}
/// The exact mean and centred sum of squares of a list of doubles.
fn mean_and_squares(v: &[f64]) -> (Rat, Rat) {
    let count = Rat::int(v.len() as i64);
    let sum = v.iter().fold(Rat::int(0), |s, e| s.add(&Rat::f(*e)));
    let mean = sum.div(&count);
    // sum (e - mean)^2 = sum (n e - sum)^2 / n^2, one common denominator
    let ss = v.iter().fold(Rat::int(0), |s, e| {
        let d = Rat::f(*e).mul(&count).sub(&sum);
        s.add(&d.mul(&d))
    });
    (mean, ss.div(&count.mul(&count)))
}
fn t_test(a: &[V]) -> Result<V, Failure> {
    let (raw_x, raw_y) = match (cells(&arg(a, 0)), cells(&arg(a, 1))) {
        (Ok(x), Ok(y)) => (x, y),
        (Err(e), _) | (_, Err(e)) => return error(e),
    };
    let tails = parsed!(numeric(&arg(a, 2))).trunc();
    let kind = parsed!(numeric(&arg(a, 3))).trunc();
    if (tails != 1.0 && tails != 2.0) || !(1.0..=3.0).contains(&kind) {
        return error(E::Num);
    }
    if kind == 1.0 && raw_x.len() != raw_y.len() {
        return error(E::Na);
    }
    let (x, y): (Vec<f64>, Vec<f64>) = if kind == 1.0 {
        raw_x.iter().zip(&raw_y).filter_map(|(p, q)| Some(((*p)?, (*q)?))).unzip()
    } else {
        (raw_x.into_iter().flatten().collect(), raw_y.into_iter().flatten().collect())
    };
    // t^2 and the degrees of freedom are exact rationals (paired differences formed exactly, no double rounding)
    let (t2, df) = parsed!(match kind as u8 {
        1 => t_paired(&x, &y),
        2 => t_pooled(&x, &y),
        _ => t_welch(&x, &y),
    });
    cert(cd::t_tail_rat(&t2, &df, tails as i64))
}
/// `(t^2, degrees of freedom)` of the paired test.
fn t_paired(x: &[f64], y: &[f64]) -> Result<(Rat, Rat), E> {
    let n = x.len() as i64;
    if n < 2 {
        return Err(E::Div0);
    }
    let (m, ss) = paired_mean_and_squares(x, y);
    if ss.is_zero() {
        return Err(E::Div0);
    }
    Ok((m.mul(&m).mul(&Rat::int(n * (n - 1))).div(&ss), Rat::int(n - 1)))
}
/// `(t^2, degrees of freedom)` of the two-sample test with equal variances.
fn t_pooled(x: &[f64], y: &[f64]) -> Result<(Rat, Rat), E> {
    let (n1, n2) = (x.len() as i64, y.len() as i64);
    if n1 < 1 || n2 < 1 || n1 + n2 <= 2 {
        return Err(E::Div0);
    }
    let one = Rat::int(1);
    let ((m1, s1), (m2, s2)) = (mean_and_squares(x), mean_and_squares(y));
    let pooled = s1.add(&s2).div(&Rat::int(n1 + n2 - 2));
    let scale = pooled.mul(&one.div(&Rat::int(n1)).add(&one.div(&Rat::int(n2))));
    if scale.is_zero() {
        return Err(E::Div0);
    }
    let d = m1.sub(&m2);
    Ok((d.mul(&d).div(&scale), Rat::int(n1 + n2 - 2)))
}
/// `(t^2, degrees of freedom)` of the two-sample test with unequal variances (Welch).
fn t_welch(x: &[f64], y: &[f64]) -> Result<(Rat, Rat), E> {
    let (n1, n2) = (x.len() as i64, y.len() as i64);
    if n1 < 2 || n2 < 2 {
        return Err(E::Div0);
    }
    let ((m1, s1), (m2, s2)) = (mean_and_squares(x), mean_and_squares(y));
    let v1 = s1.div(&Rat::int((n1 - 1) * n1));
    let v2 = s2.div(&Rat::int((n2 - 1) * n2));
    let v = v1.add(&v2);
    if v.is_zero() {
        return Err(E::Div0);
    }
    let d = m1.sub(&m2);
    let den = v1.mul(&v1).div(&Rat::int(n1 - 1)).add(&v2.mul(&v2).div(&Rat::int(n2 - 1)));
    Ok((d.mul(&d).div(&v), v.mul(&v).div(&den)))
}
/// The exact mean and centred sum of squares of the paired differences.
fn paired_mean_and_squares(x: &[f64], y: &[f64]) -> (Rat, Rat) {
    let count = Rat::int(x.len() as i64);
    let d: Vec<Rat> = x.iter().zip(y).map(|(p, q)| Rat::f(*p).sub(&Rat::f(*q))).collect();
    let sum = d.iter().fold(Rat::int(0), |s, e| s.add(e));
    let ss = d.iter().fold(Rat::int(0), |s, e| {
        let c = e.mul(&count).sub(&sum);
        s.add(&c.mul(&c))
    });
    (sum.div(&count), ss.div(&count.mul(&count)))
}
/// A range as rows of cells; a single column arrives as a flat array of scalars.
fn grid(v: &V) -> Option<Vec<Vec<V>>> {
    // a single-cell reference arrives as the cell's value: a 1x1 range
    let V::Array(rows) = v else { return Some(vec![vec![v.clone()]]) };
    Some(
        rows.iter()
            .map(|r| match r {
                V::Array(cells) => cells.clone(),
                cell => vec![cell.clone()],
            })
            .collect(),
    )
}
fn chisq_test(a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let (Some(observed), Some(expected)) = (grid(&a[0]), grid(&a[1])) else {
        return error(E::Value);
    };
    // Ranges of different shapes (or an empty one) are #N/A.
    let columns = observed.first().map_or(0, Vec::len);
    if observed.is_empty() || observed.len() != expected.len() || observed.iter().chain(&expected).any(|r| r.len() != columns) {
        return error(E::Na);
    }
    let rows = observed.len();
    // A single cell has no degrees of freedom: #N/A, as Excel gives.
    if rows == 1 && columns == 1 {
        return error(E::Na);
    }
    // An error cell is the result (the observed range is read before the expected one); a pair in which either cell
    // is text, a logical or blank is left out of the statistic while the degrees of freedom keep the range's shape.
    for cell in observed.iter().chain(&expected).flatten() {
        if let V::Error(e) = cell {
            return error(*e);
        }
    }
    // the statistic sum (o - e)^2 / e is accumulated exactly
    let mut statistic = Rat::int(0);
    for (orow, erow) in observed.iter().zip(&expected) {
        for (o, e) in orow.iter().zip(erow) {
            let (V::Number(o), V::Number(e)) = (o, e) else { continue };
            if *e == 0.0 {
                return error(E::Div0);
            }
            let d = Rat::f(*o).sub(&Rat::f(*e));
            statistic = statistic.add(&d.mul(&d).div(&Rat::f(*e)));
        }
    }
    let df = if rows == 1 {
        columns as f64 - 1.0
    } else if columns == 1 {
        rows as f64 - 1.0
    } else {
        (rows as f64 - 1.0) * (columns as f64 - 1.0)
    };
    if df < 1.0 {
        return error(E::Div0);
    }
    // negative expected cells can make the statistic negative: #NUM! as before (outside the chi-square domain)
    if statistic.sign() == std::cmp::Ordering::Less {
        return error(E::Num);
    }
    cert(cd::chisq_upper_rat(&statistic, df))
}

macro_rules! functions {($( $rust:ident => $name:literal ),+ $(,)?)=>{$(fn $rust(a:&[V])->Result<V,Failure>{run($name,a)})+};}
functions! {
 beta_dist=>"BETA.DIST",beta_inv=>"BETA.INV",binom_dist=>"BINOM.DIST",binom_range=>"BINOM.DIST.RANGE",binom_inv=>"BINOM.INV",
 chisq_dist=>"CHISQ.DIST",chisq_rt=>"CHISQ.DIST.RT",chisq_inv=>"CHISQ.INV",chisq_inv_rt=>"CHISQ.INV.RT",chisq_test_fn=>"CHISQ.TEST",
 confidence_norm=>"CONFIDENCE.NORM",confidence_t=>"CONFIDENCE.T",expon_dist=>"EXPON.DIST",f_dist=>"F.DIST",f_rt=>"F.DIST.RT",f_inv=>"F.INV",f_inv_rt=>"F.INV.RT",f_test_fn=>"F.TEST",
 gamma=>"GAMMA",gamma_dist=>"GAMMA.DIST",gamma_inv=>"GAMMA.INV",gammaln=>"GAMMALN",gammaln_precise=>"GAMMALN.PRECISE",gauss=>"GAUSS",hypgeom=>"HYPGEOM.DIST",lognorm_dist=>"LOGNORM.DIST",lognorm_inv=>"LOGNORM.INV",negbinom=>"NEGBINOM.DIST",
 norm_dist=>"NORM.DIST",norm_inv=>"NORM.INV",norm_s_dist=>"NORM.S.DIST",norm_s_inv=>"NORM.S.INV",phi=>"PHI",poisson=>"POISSON.DIST",prob_fn=>"PROB",hypgeomdist=>"HYPGEOMDIST",negbinomdist=>"NEGBINOMDIST",chidist=>"CHIDIST",chiinv=>"CHIINV",fdist=>"FDIST",finv=>"FINV",tinv=>"TINV",normsdist=>"NORMSDIST",lognormdist=>"LOGNORMDIST",betadist=>"BETADIST",t_dist=>"T.DIST",tdist=>"TDIST",t_2t=>"T.DIST.2T",t_rt=>"T.DIST.RT",t_inv=>"T.INV",t_inv_2t=>"T.INV.2T",t_test_fn=>"T.TEST",weibull=>"WEIBULL.DIST",z_test=>"Z.TEST",
}

pub const FUNCTIONS: Table = &[
    ("BETA.DIST", beta_dist),
    ("BETA.INV", beta_inv),
    ("BETADIST", betadist),
    ("BETAINV", beta_inv),
    ("BINOM.DIST", binom_dist),
    ("BINOM.DIST.RANGE", binom_range),
    ("BINOM.INV", binom_inv),
    ("BINOMDIST", binom_dist),
    ("BINOMDIST.RANGE", binom_range),
    ("CHIDIST", chidist),
    ("CHIDIST.RT", chisq_rt),
    ("CHIDISTRT", chisq_rt),
    ("CHIINV", chiinv),
    ("CHIINV.RT", chisq_inv_rt),
    ("CHIINVRT", chisq_inv_rt),
    ("CHISQ.DIST", chisq_dist),
    ("CHISQ.DIST.RT", chisq_rt),
    ("CHISQ.INV", chisq_inv),
    ("CHISQ.INV.RT", chisq_inv_rt),
    ("CHISQ.TEST", chisq_test_fn),
    ("CHITEST", chisq_test_fn),
    ("CONFIDENCE.NORM", confidence_norm),
    ("CONFIDENCE.T", confidence_t),
    ("CRITBINOM", binom_inv),
    ("EXPON.DIST", expon_dist),
    ("EXPONDIST", expon_dist),
    ("F.DIST", f_dist),
    ("F.DIST.RT", f_rt),
    ("F.INV", f_inv),
    ("F.INV.RT", f_inv_rt),
    ("F.TEST", f_test_fn),
    ("FDIST", fdist),
    ("FDIST.RT", f_rt),
    ("FDISTRT", f_rt),
    ("FINV", finv),
    ("FINV.RT", f_inv_rt),
    ("FINVRT", f_inv_rt),
    ("FTEST", f_test_fn),
    ("GAMMA", gamma),
    ("GAMMA.DIST", gamma_dist),
    ("GAMMA.INV", gamma_inv),
    ("GAMMADIST", gamma_dist),
    ("GAMMAINV", gamma_inv),
    ("GAMMALN", gammaln),
    ("GAMMALN.PRECISE", gammaln_precise),
    ("GAMMALNPRECISE", gammaln_precise),
    ("GAUSS", gauss),
    ("HYPGEOM.DIST", hypgeom),
    ("HYPGEOMDIST", hypgeomdist),
    ("LOGINV", lognorm_inv),
    ("LOGNORM.DIST", lognorm_dist),
    ("LOGNORM.INV", lognorm_inv),
    ("LOGNORMDIST", lognormdist),
    ("LOGNORMINV", lognorm_inv),
    ("NEGBINOM.DIST", negbinom),
    ("NEGBINOMDIST", negbinomdist),
    ("NORM.DIST", norm_dist),
    ("NORM.INV", norm_inv),
    ("NORM.S.DIST", norm_s_dist),
    ("NORM.S.INV", norm_s_inv),
    ("NORMDIST", norm_dist),
    ("NORMINV", norm_inv),
    ("NORMSDIST", normsdist),
    ("NORMSINV", norm_s_inv),
    ("PHI", phi),
    ("POISSON.DIST", poisson),
    ("POISSONDIST", poisson),
    ("PROB", prob_fn),
    ("T.DIST", t_dist),
    ("T.DIST.2T", t_2t),
    ("T.DIST.RT", t_rt),
    ("T.INV", t_inv),
    ("T.INV.2T", t_inv_2t),
    ("T.TEST", t_test_fn),
    ("TDIST", tdist),
    ("TDIST.2T", t_2t),
    ("TDIST.RT", t_rt),
    ("TDISTRT", t_rt),
    ("TINV", tinv),
    ("TINV.2T", t_inv_2t),
    ("TTEST", t_test_fn),
    ("WEIBULL.DIST", weibull),
    ("WEIBULLDIST", weibull),
    ("Z.TEST", z_test),
    ("ZTEST", z_test),
];
