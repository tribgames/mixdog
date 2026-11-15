//! Statistical distribution wrappers from formulajs 4.6.1, including legacy
//! aliases and its type/error-order quirks. No textbook domain checks are added.
//! Copyright (c) 2014 Sutoiku, Inc., MIT; notice in office-stats-distributions.
// Preserve source-indexed/ragged matrix loops and NaN-sensitive comparisons.
#![allow(clippy::needless_range_loop, clippy::manual_range_contains)]
use super::jstat::{self as j, N, n};
use crate::coerce::{flatten, is_truthy, parse_number, parse_number_array, to_js_number};
use crate::registry::{Table, library};
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::{js_sort_by, number_to_string, parse_int_radix};
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
fn array(v: &V) -> Result<Vec<f64>, E> {
    parse_number_array(&flatten(std::slice::from_ref(v)))
        .map(|v| v.iter().map(to_js_number).collect())
}
fn error(e: E) -> Result<V, Failure> {
    Ok(V::Error(e))
}
fn value(x: impl Into<N>) -> Result<V, Failure> {
    Ok(x.into().value())
}
fn raw(v: &V) -> f64 {
    to_js_number(v)
}
fn actual_number(v: &V) -> Option<f64> {
    if let V::Number(n) = v { Some(*n) } else { None }
}
fn shared(name: &str, args: &[V]) -> Result<N, Failure> {
    let call = library().resolve(name).ok_or_else(|| {
        Failure::unsupported(format!("distribution dependency {name} is not registered"))
    })?;
    Ok(n(to_js_number(&call(args)?)))
}
fn call(name: &str, args: &[V]) -> Result<N, Failure> {
    Ok(n(to_js_number(&run(name, args)?)))
}
fn list(values: &[f64]) -> V {
    V::Array(values.iter().map(|x| V::Number(*x)).collect())
}
macro_rules! parsed {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(_) => return error(E::Value),
        }
    };
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    match name {
        "BETA.DIST" => {
            if a.len() < 4 {
                return error(E::Value);
            }
            let p = parsed!(nums(
                &[
                    arg(a, 0),
                    arg(a, 1),
                    arg(a, 2),
                    default(a, 4, V::Number(0.0)),
                    default(a, 5, V::Number(1.0))
                ],
                5
            ));
            let x = ((n(p[0]) - p[3]) / (n(p[4]) - p[3])).0;
            value(if is_truthy(&arg(a, 3)) {
                j::beta_cdf(x, p[1], p[2])
            } else {
                j::beta_pdf(x, p[1], p[2])
            })
        }
        "BETA.INV" => {
            let p = parsed!(nums(
                &[
                    arg(a, 0),
                    arg(a, 1),
                    arg(a, 2),
                    default(a, 3, V::Number(0.0)),
                    default(a, 4, V::Number(1.0))
                ],
                5
            ));
            value(j::beta_inv(p[0], p[1], p[2]) * (n(p[4]) - p[3]) + p[3])
        }
        "BINOM.DIST" => {
            let p = parsed!(nums(a, 4));
            value(if is_truthy(&V::Number(p[3])) {
                j::binomial_cdf(p[0], p[1], p[2])
            } else {
                j::binomial_pdf(p[0], p[1], p[2])
            })
        }
        "BINOM.DIST.RANGE" => {
            let p = parsed!(nums(
                &[arg(a, 0), arg(a, 1), arg(a, 2), default(a, 3, arg(a, 2))],
                4
            ));
            let mut result = n(0.0);
            let mut i = p[2];
            while i <= p[3] {
                result += shared("COMBIN", &[V::Number(p[0]), V::Number(i)])?
                    * j::pow(p[1], i)
                    * j::pow(1.0 - n(p[1]), n(p[0]) - i);
                i += 1.0;
            }
            value(result)
        }
        "BINOM.INV" => {
            let p = parsed!(nums(a, 3));
            let mut x = 0.0;
            while x <= p[0] {
                if j::binomial_cdf(x, p[0], p[1]) >= p[2] {
                    return value(x);
                }
                x += 1.0;
            }
            Ok(V::Undefined)
        }
        "CHISQ.DIST" => {
            let p = parsed!(nums(a, 2));
            value(if is_truthy(&arg(a, 2)) {
                j::chisquare_cdf(p[0], p[1])
            } else {
                j::chisquare_pdf(p[0], p[1])
            })
        }
        "CHISQ.DIST.RT" => {
            let (x, d) = (arg(a, 0), arg(a, 1));
            if !is_truthy(&x) || !is_truthy(&d) {
                return error(E::Na);
            }
            if raw(&x) < 1.0 || raw(&d) > 1e10 {
                return error(E::Num);
            }
            let (Some(x), Some(d)) = (actual_number(&x), actual_number(&d)) else {
                return error(E::Value);
            };
            value(1.0 - j::chisquare_cdf(x, d))
        }
        "CHISQ.INV" => {
            let p = parsed!(nums(a, 2));
            value(j::chisquare_inv(p[0], p[1]))
        }
        "CHISQ.INV.RT" => {
            let (p, d) = (arg(a, 0), arg(a, 1));
            if !is_truthy(&p) || !is_truthy(&d) {
                return error(E::Na);
            }
            if raw(&p) < 0.0 || raw(&p) > 1.0 || raw(&d) < 1.0 || raw(&d) > 1e10 {
                return error(E::Num);
            }
            let (Some(p), Some(d)) = (actual_number(&p), actual_number(&d)) else {
                return error(E::Value);
            };
            value(j::chisquare_inv(1.0 - p, d))
        }
        "CHISQ.TEST" => chisq_test(a),
        "CONFIDENCE.NORM" | "CONFIDENCE.T" => {
            let p = parsed!(nums(a, 3));
            let inverse = if name == "CONFIDENCE.NORM" {
                j::normal_inv((n(p[0]) / 2.0).0, 0.0, 1.0)
            } else {
                j::student_inv((n(p[0]) / 2.0).0, (n(p[2]) - 1.0).0)
            };
            let change = j::abs(inverse * p[1] / j::sqrt(p[2]));
            value((1.0 + change) - 1.0)
        }
        "EXPON.DIST" => {
            let p = parsed!(nums(a, 2));
            value(if is_truthy(&arg(a, 2)) {
                j::exponential_cdf(p[0], p[1])
            } else {
                j::exponential_pdf(p[0], p[1])
            })
        }
        "F.DIST" => {
            let p = parsed!(nums(a, 3));
            if is_truthy(&arg(a, 3)) {
                Ok(j::central_f_cdf(p[0], p[1], p[2]))
            } else {
                value(j::central_f_pdf(p[0], p[1], p[2]))
            }
        }
        "F.DIST.RT" | "F.INV.RT" => {
            if a.len() != 3 {
                return error(E::Na);
            }
            let p = [raw(&arg(a, 0)), raw(&arg(a, 1)), raw(&arg(a, 2))];
            if p[0] < 0.0
                || p[1] < 1.0
                || p[2] < 1.0
                || (name == "F.INV.RT" && (p[0] > 1.0 || p[1] > 1e10 || p[2] > 1e10))
            {
                return error(E::Num);
            }
            if a.iter().any(|v| actual_number(v).is_none()) {
                return error(E::Value);
            }
            if name == "F.DIST.RT" {
                value(1.0 - n(to_js_number(&j::central_f_cdf(p[0], p[1], p[2]))))
            } else {
                value(j::central_f_inv(1.0 - p[0], p[1], p[2]))
            }
        }
        "F.INV" => {
            let p = parsed!(nums(a, 3));
            if p[0] <= 0.0 || p[0] > 1.0 {
                return error(E::Num);
            }
            value(j::central_f_inv(p[0], p[1], p[2]))
        }
        "F.TEST" => f_test(a),
        "GAMMA" | "GAMMALN" | "GAUSS" => {
            let x = match numeric(&arg(a, 0)) {
                Ok(x) => x,
                Err(e) => return error(e),
            };
            if name == "GAMMA" {
                if x == 0.0 || (parse_int_radix(&number_to_string(x), 10.0) == x && x < 0.0) {
                    return error(E::Num);
                }
                value(j::gammafn(x))
            } else if name == "GAMMALN" {
                value(j::gammaln(x))
            } else {
                value(j::normal_cdf(x, 0.0, 1.0) - 0.5)
            }
        }
        "GAMMA.DIST" | "GAMMA.INV" => {
            if a.len() != if name == "GAMMA.DIST" { 4 } else { 3 } {
                return error(E::Na);
            }
            let p = [raw(&arg(a, 0)), raw(&arg(a, 1)), raw(&arg(a, 2))];
            if p[0] < 0.0 || p[1] <= 0.0 || p[2] <= 0.0 || (name == "GAMMA.INV" && p[0] > 1.0) {
                return error(if name == "GAMMA.INV" {
                    E::Num
                } else {
                    E::Value
                });
            }
            if (0..3).any(|i| actual_number(&a[i]).is_none()) {
                return error(E::Value);
            }
            value(if name == "GAMMA.INV" {
                j::gamma_inv(p[0], p[1], p[2])
            } else if is_truthy(&arg(a, 3)) {
                j::gamma_cdf(p[0], p[1], p[2])
            } else {
                j::gamma_pdf(p[0], p[1], p[2])
            })
        }
        "GAMMALN.PRECISE" => {
            if a.len() != 1 {
                return error(E::Na);
            }
            if raw(&a[0]) <= 0.0 {
                return error(E::Num);
            }
            let Some(x) = actual_number(&a[0]) else {
                return error(E::Value);
            };
            value(j::gammaln(x))
        }
        "HYPGEOM.DIST" => {
            let p = parsed!(nums(a, 4));
            let pdf = |x: f64| -> Result<N, Failure> {
                Ok(shared("COMBIN", &[V::Number(p[2]), V::Number(x)])?
                    * shared("COMBIN", &[V::Number(p[3] - p[2]), V::Number(p[1] - x)])?
                    / shared("COMBIN", &[V::Number(p[3]), V::Number(p[1])])?)
            };
            if is_truthy(&arg(a, 4)) {
                let mut result = n(0.0);
                let mut i = 0.0;
                while i <= p[0] {
                    result += pdf(i)?;
                    i += 1.0;
                }
                value(result)
            } else {
                value(pdf(p[0])?)
            }
        }
        "LOGNORM.DIST" => {
            let p = parsed!(nums(a, 3));
            value(if is_truthy(&arg(a, 3)) {
                j::lognormal_cdf(p[0], p[1], p[2])
            } else {
                j::lognormal_pdf(p[0], p[1], p[2])
            })
        }
        "LOGNORM.INV" => {
            let p = parsed!(nums(a, 3));
            value(j::lognormal_inv(p[0], p[1], p[2]))
        }
        "NEGBINOM.DIST" => {
            let p = parsed!(nums(a, 3));
            if is_truthy(&arg(a, 3)) {
                value(j::negbin_cdf(p[0], p[1], p[2]))
            } else {
                Ok(j::negbin_pdf(p[0], p[1], p[2]))
            }
        }
        "NORM.DIST" => {
            let p = parsed!(nums(a, 3));
            if p[2] <= 0.0 {
                return error(E::Num);
            }
            value(if is_truthy(&arg(a, 3)) {
                j::normal_cdf(p[0], p[1], p[2])
            } else {
                j::normal_pdf(p[0], p[1], p[2])
            })
        }
        "NORM.INV" => {
            let p = parsed!(nums(a, 3));
            value(j::normal_inv(p[0], p[1], p[2]))
        }
        "NORM.S.DIST" => {
            let p = parsed!(nums(a, 1));
            value(if is_truthy(&arg(a, 1)) {
                j::normal_cdf(p[0], 0.0, 1.0)
            } else {
                j::normal_pdf(p[0], 0.0, 1.0)
            })
        }
        "NORM.S.INV" => {
            let p = parsed!(nums(a, 1));
            value(j::normal_inv(p[0], 0.0, 1.0))
        }
        "PHI" => {
            let p = parsed!(nums(a, 1));
            value(j::exp(-0.5 * n(p[0]) * p[0]) / 2.5066282746310002)
        }
        "POISSON.DIST" => {
            let p = parsed!(nums(a, 2));
            value(if is_truthy(&arg(a, 2)) {
                j::poisson_cdf(p[0], p[1])
            } else {
                j::poisson_pdf(p[0], p[1])
            })
        }
        "PROB" => prob(a),
        "T.DIST" => match arg(a, 2) {
            V::Number(1.0) => run("T.DIST.RT", &[arg(a, 0), arg(a, 1)]),
            V::Number(2.0) => run("T.DIST.2T", &[arg(a, 0), arg(a, 1)]),
            _ => error(E::Num),
        },
        "T.DIST.RT" | "T.DIST.2T" => {
            if a.len() != 2 {
                return error(E::Na);
            }
            if raw(&a[0]) < 0.0 || raw(&a[1]) < 1.0 {
                return error(E::Num);
            }
            let (Some(x), Some(d)) = (actual_number(&a[0]), actual_number(&a[1])) else {
                return error(E::Value);
            };
            let p = 1.0 - j::student_cdf(x, d);
            value(if name == "T.DIST.2T" { p * 2.0 } else { p })
        }
        "T.INV" => {
            let p = parsed!(nums(a, 2));
            value(j::student_inv(p[0], p[1]))
        }
        "T.INV.2T" => {
            let p = parse_number(&arg(a, 0));
            let d = parse_number(&arg(a, 1));
            let (pn, dn) = (raw(&p), raw(&d));
            if pn <= 0.0 || pn > 1.0 || dn < 1.0 {
                return error(E::Num);
            }
            if matches!(p, V::Error(_)) || matches!(d, V::Error(_)) {
                return error(E::Value);
            }
            value(j::abs(j::student_inv(pn / 2.0, dn)))
        }
        "T.TEST" => t_test(a),
        "WEIBULL.DIST" => {
            let p = parsed!(nums(a, 3));
            let (x, alpha, beta) = (n(p[0]), n(p[1]), n(p[2]));
            value(if is_truthy(&arg(a, 3)) {
                1.0 - j::exp(-j::pow(x / beta, alpha))
            } else {
                j::pow(x, alpha - 1.0) * j::exp(-j::pow(x / beta, alpha)) * alpha
                    / j::pow(beta, alpha)
            })
        }
        "Z.TEST" => {
            let a0 = parsed!(array(&arg(a, 0)));
            let x = parsed!(numeric(&arg(a, 1)));
            let sigma = arg(a, 2);
            let sigma = if is_truthy(&sigma) {
                n(to_js_number(&sigma))
            } else {
                shared("STDEV.S", &[list(&a0)])?
            };
            let z = (shared("AVERAGE", &[list(&a0)])? - x) / (sigma / j::sqrt(a0.len() as f64));
            value(1.0 - call("NORM.S.DIST", &[V::Number(z.0), V::Bool(true)])?)
        }
        _ => unreachable!("registered distribution"),
    }
}
fn prob(a: &[V]) -> Result<V, Failure> {
    if matches!(arg(a, 2), V::Undefined) {
        return value(0.0);
    }
    let mut x = parsed!(array(&arg(a, 0)));
    let p = parsed!(array(&arg(a, 1)));
    let lo = parsed!(numeric(&arg(a, 2)));
    let hi = parsed!(numeric(&default(a, 3, arg(a, 2))));
    if lo == hi {
        return Ok(x.iter().position(|v| *v == lo).map_or(V::Number(0.0), |i| {
            p.get(i).copied().map_or(V::Undefined, V::Number)
        }));
    }
    js_sort_by(&mut x, |a, b| a - b);
    let mut result = n(0.0);
    for &v in &x {
        if v >= lo && v <= hi {
            let at = x.iter().position(|n| *n == v);
            result += n(at.and_then(|i| p.get(i)).copied().unwrap_or(f64::NAN));
        }
    }
    value(result)
}
fn f_test(a: &[V]) -> Result<V, Failure> {
    let (x, y) = (arg(a, 0), arg(a, 1));
    if !is_truthy(&x) || !is_truthy(&y) {
        return error(E::Na);
    }
    let (V::Array(xa), V::Array(ya)) = (&x, &y) else {
        return error(E::Na);
    };
    if xa.len() < 2 || ya.len() < 2 {
        return error(E::Div0);
    }
    let xm = shared("SUM", std::slice::from_ref(&x))? / (xa.len() as f64);
    let ym = shared("SUM", std::slice::from_ref(&y))? / (ya.len() as f64);
    let squares = |v: &[V], mean: N| {
        let mut result = n(0.0);
        for x in v {
            result += j::pow(n(raw(x)) - mean, 2.0);
        }
        result
    };
    value((squares(xa, xm) / (xa.len() as f64 - 1.0)) / (squares(ya, ym) / (ya.len() as f64 - 1.0)))
}
fn t_test(a: &[V]) -> Result<V, Failure> {
    let x = parsed!(array(&arg(a, 0)));
    let y = parsed!(array(&arg(a, 1)));
    let xm = super::statistical::mean(&x);
    let ym = super::statistical::mean(&y);
    let (mut sx, mut sy) = (n(0.0), n(0.0));
    for &v in &x {
        sx += j::pow(n(v) - xm, 2.0);
    }
    for &v in &y {
        sy += j::pow(n(v) - ym, 2.0);
    }
    sx /= x.len() as f64 - 1.0;
    sy /= y.len() as f64 - 1.0;
    let t = j::abs(n(xm) - ym) / j::sqrt(sx / (x.len() as f64) + sy / (y.len() as f64));
    run(
        "T.DIST.2T",
        &[V::Number(t.0), V::Number((x.len() + y.len()) as f64 - 2.0)],
    )
}
fn row_length(v: &V) -> Option<usize> {
    match v {
        V::Array(v) => Some(v.len()),
        V::Text(s) => Some(s.encode_utf16().count()),
        _ => None,
    }
}
fn chisq_test(a: &[V]) -> Result<V, Failure> {
    if a.len() != 2 {
        return error(E::Na);
    }
    let (V::Array(x), V::Array(y)) = (&a[0], &a[1]) else {
        return error(E::Value);
    };
    if x.len() != y.len() {
        return error(E::Value);
    }
    if let (Some(x), Some(y)) = (x.first(), y.first()) {
        if is_truthy(x) && is_truthy(y) && row_length(x) != row_length(y) {
            return error(E::Value);
        }
    }
    let wrap = |a: &[V]| {
        a.iter()
            .map(|v| match v {
                V::Array(row) => row.clone(),
                v => vec![v.clone()],
            })
            .collect::<Vec<_>>()
    };
    let (x, y) = (wrap(x), wrap(y));
    let rows = x.len();
    let Some(first) = x.first() else {
        return Err(Failure::thrown(
            "Cannot read properties of undefined (reading 'length')",
        ));
    };
    let columns = first.len();
    let dof = if columns == 1 {
        rows as f64 - 1.0
    } else {
        (rows as f64 - 1.0) * (columns as f64 - 1.0)
    };
    let mut statistic = n(0.0);
    for i in 0..rows {
        for k in 0..columns {
            let observed = n(raw(x[i].get(k).unwrap_or(&V::Undefined)));
            let expected = n(raw(y[i].get(k).unwrap_or(&V::Undefined)));
            statistic += j::pow(observed - expected, 2.0) / expected;
        }
    }
    let mut p = j::exp(-0.5 * statistic);
    if dof % 2.0 == 1.0 {
        p *= j::sqrt((2.0 * statistic) / std::f64::consts::PI);
    }
    let mut k = n(dof);
    while k >= 2.0 {
        p = (p * statistic) / k;
        k -= 2.0;
    }
    let (mut t, mut next) = (p, n(dof));
    while t > 0.0000000001 * p {
        next += 2.0;
        t = (t * statistic) / next;
        p += t;
    }
    value(n(mixdog_js::math::round(((1.0 - p) * 1000000.0).0)) / 1000000.0)
}

macro_rules! functions {($( $rust:ident => $name:literal ),+ $(,)?)=>{$(fn $rust(a:&[V])->Result<V,Failure>{run($name,a)})+};}
functions! {
 beta_dist=>"BETA.DIST",beta_inv=>"BETA.INV",binom_dist=>"BINOM.DIST",binom_range=>"BINOM.DIST.RANGE",binom_inv=>"BINOM.INV",
 chisq_dist=>"CHISQ.DIST",chisq_rt=>"CHISQ.DIST.RT",chisq_inv=>"CHISQ.INV",chisq_inv_rt=>"CHISQ.INV.RT",chisq_test_fn=>"CHISQ.TEST",
 confidence_norm=>"CONFIDENCE.NORM",confidence_t=>"CONFIDENCE.T",expon_dist=>"EXPON.DIST",f_dist=>"F.DIST",f_rt=>"F.DIST.RT",f_inv=>"F.INV",f_inv_rt=>"F.INV.RT",f_test_fn=>"F.TEST",
 gamma=>"GAMMA",gamma_dist=>"GAMMA.DIST",gamma_inv=>"GAMMA.INV",gammaln=>"GAMMALN",gammaln_precise=>"GAMMALN.PRECISE",gauss=>"GAUSS",hypgeom=>"HYPGEOM.DIST",lognorm_dist=>"LOGNORM.DIST",lognorm_inv=>"LOGNORM.INV",negbinom=>"NEGBINOM.DIST",
 norm_dist=>"NORM.DIST",norm_inv=>"NORM.INV",norm_s_dist=>"NORM.S.DIST",norm_s_inv=>"NORM.S.INV",phi=>"PHI",poisson=>"POISSON.DIST",prob_fn=>"PROB",t_dist=>"T.DIST",t_2t=>"T.DIST.2T",t_rt=>"T.DIST.RT",t_inv=>"T.INV",t_inv_2t=>"T.INV.2T",t_test_fn=>"T.TEST",weibull=>"WEIBULL.DIST",z_test=>"Z.TEST",
}

pub const FUNCTIONS: Table = &[
    ("BETA.DIST", beta_dist),
    ("BETA.INV", beta_inv),
    ("BETADIST", beta_dist),
    ("BETAINV", beta_inv),
    ("BINOM.DIST", binom_dist),
    ("BINOM.DIST.RANGE", binom_range),
    ("BINOM.INV", binom_inv),
    ("BINOMDIST", binom_dist),
    ("BINOMDIST.RANGE", binom_range),
    ("CHIDIST", chisq_dist),
    ("CHIDIST.RT", chisq_rt),
    ("CHIDISTRT", chisq_rt),
    ("CHIINV", chisq_inv),
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
    ("FDIST", f_dist),
    ("FDIST.RT", f_rt),
    ("FDISTRT", f_rt),
    ("FINV", f_inv),
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
    ("HYPGEOMDIST", hypgeom),
    ("LOGINV", lognorm_inv),
    ("LOGNORM.DIST", lognorm_dist),
    ("LOGNORM.INV", lognorm_inv),
    ("LOGNORMDIST", lognorm_dist),
    ("LOGNORMINV", lognorm_inv),
    ("NEGBINOM.DIST", negbinom),
    ("NEGBINOMDIST", negbinom),
    ("NORM.DIST", norm_dist),
    ("NORM.INV", norm_inv),
    ("NORM.S.DIST", norm_s_dist),
    ("NORM.S.INV", norm_s_inv),
    ("NORMDIST", norm_dist),
    ("NORMINV", norm_inv),
    ("NORMSDIST", norm_s_dist),
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
    ("TDIST", t_dist),
    ("TDIST.2T", t_2t),
    ("TDIST.RT", t_rt),
    ("TDISTRT", t_rt),
    ("TINV", t_inv),
    ("TINV.2T", t_inv_2t),
    ("TTEST", t_test_fn),
    ("WEIBULL.DIST", weibull),
    ("WEIBULLDIST", weibull),
    ("Z.TEST", z_test),
    ("ZTEST", z_test),
];
