//! Certified numerics for the statistical worksheet functions (design: xlsx-numerics-design.md). Kernels take the
//! worksheet's own coordinates and exact counts, compute enclosures (balls) in dyadic arithmetic with explicit
//! remainder bounds, and round only the final result; the working precision is raised until the enclosure decides
//! the double (a bounded number of doublings, see `certify`).

pub(super) mod ball;
pub(super) mod discrete;
pub(super) mod dist;
pub(super) mod export;
pub(super) mod gammafn;
pub(super) mod inverse;
pub(super) mod num;
pub(super) mod quad;
pub(super) mod rat;
pub(super) mod ser;

#[cfg(test)]
#[allow(clippy::excessive_precision)] // the reference values are mpmath digits
mod tests {
    use super::ball::*;
    use super::num::Fl;

    fn close(b: &B, want: f64) {
        let got = b.to_f64();
        assert!(((got - want) / want).abs() < 1e-15, "{got:e} vs {want:e}");
        assert!(b.rel_ok(60), "radius too wide: {b:?}");
    }

    #[test]
    fn primitives_enclose_known_values() {
        with_prec(128, || {
            close(&pi(), std::f64::consts::PI);
            close(&ln2(), std::f64::consts::LN_2);
            close(&exp(&B::f(1.0)), std::f64::consts::E);
            close(&exp(&B::f(-700.0)), 9.859676543759770e-305);
            close(&ln(&B::f(10.0)), std::f64::consts::LN_10);
            close(&log1p(&B::f(1e-300)), 1e-300);
            close(&expm1(&B::f(1e-300)), 1e-300);
            close(&sqrt(&B::f(2.0)), std::f64::consts::SQRT_2);
            close(&B::f(3.0).recip(), 1.0 / 3.0);
            close(&sinpi(&Fl::from_f64(0.5)), 1.0);
            close(&sinpi(&Fl::from_f64(1.0 / 6.0)), 0.5);
            let big = exp(&B::f(700.0));
            close(&big, 1.0142320547350045e304);
        });
    }

    #[test]
    fn log_gamma_matches_mpmath() {
        use super::gammafn::lgamma;
        with_prec(128, || {
            close(&lgamma(&B::f(1e-300)), 690.7755278982137);
            // 7.08e310 is beyond the double range: compared scaled by 2^-1000
            close(&lgamma(&B::f(1e308)).mul_2exp(-1000), 6609337562.876484840);
            close(&lgamma(&B::f(0.5)), 0.5723649429247001);
            close(&lgamma(&B::f(100.25)), 360.28455963776423);
            assert!(lgamma(&B::f(1.0)).is_exact_zero());
        });
    }

    fn tail(v: &super::export::Val) -> f64 {
        super::export::prob(v).unwrap()
    }

    #[test]
    fn gamma_and_beta_tails_match_mpmath() {
        use super::export::certify;
        use super::quad::{beta_tails, gamma_tails};
        // P(a, t) and Q(a, t) at vx = ln(t/a); I_x(a, b) at vx = ln(x b / (y a))
        let g = |a: f64, t: f64, upper: bool| {
            let v = certify(|| {
                let a = B::f(a);
                let vx = ln(&B::f(t).div(&a));
                let t = gamma_tails(&a, &vx);
                if upper { t.upper } else { t.lower }
            });
            tail(&v)
        };
        let rel = |got: f64, want: f64| assert!(((got - want) / want).abs() < 1e-13, "{got:e} vs {want:e}");
        rel(g(1e-300, 1.0, true), 2.193839343955203e-301);
        rel(g(1000.0, 900.0, false), 0.0005499022657117829);
        rel(g(1000.0, 1100.0, true), 0.001059323253929977);
        rel(g(2.5, 2.0, false), 0.45058404864721977);
        // shapes below 2^-20 under the mode take the series (the mode-centred lower flank is 1/a long); above it,
        // the upper flank starts from a curvature scale past the exponential's range (a = 1e-200: 2^333)
        rel(g(1e-20, 5e-21, true), 4.6167633375539323641e-19);
        rel(g(1e-20, 5e-21, false), 1.0);
        rel(g(1e-300, 2e-301, true), 6.9180775014574628999e-298);
        rel(g(1e-200, 1.1e-200, true), 4.5984449275410327079e-198);
        rel(g(1e-200, 1.1e-200, false), 1.0);
        let b = |a: f64, bb: f64, x: f64| {
            let v = certify(|| {
                let (ab, bb_) = (B::f(a), B::f(bb));
                let vx = ln(&B::f(x).mul(&bb_).div(&B::f(1.0 - x).mul(&ab)));
                beta_tails(&ab, &bb_, &vx).lower
            });
            tail(&v)
        };
        rel(b(0.5, 3.0, 0.9), 0.9996750253207289);
        rel(b(3.0, 0.5, 0.1), 0.0003249746792710837);
        rel(b(200.0, 300.0, 0.3), 1.049698524329294670e-6);
        rel(b(2.0, 3.0, 0.4), 0.5248);
    }
}
