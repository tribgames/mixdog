//! The discrete worksheet kernels with exact counts (design "Dispatch": binomial, negative binomial, Poisson,
//! hypergeometric). Counts arrive as truncated doubles and stay exact dyadic integers (`Fl`); `k + 1`, `n - k`,
//! support ends and loop positions are never doubles. Tails are incomplete beta / gamma integrals in the orientation
//! that is the requested tail; masses are the beta / gamma densities at integer shapes; the hypergeometric mass is the
//! cell-divergence form and its tails are lattice sums with certified panels (`quad::lattice_log`).

use super::ball::{B, exp, ln, log1p, log1pmx, prec, with_prec};
use super::export::{Val, certified_prob};
use super::gammafn::{half_ln_2pi, hurwitz_all, lgamma, psi_tilde, stirling_rem};
use super::num::{Fl, Mag};
use super::quad::{Family, Tails, beta_log_mass, beta_tails, gamma_log_mass, gamma_tails, lattice_log};
use super::rat::Rat;
use crate::value::ErrorValue as E;
use std::cmp::Ordering;

type R = Result<f64, E>;

fn one() -> Fl {
    Fl::from_i64(1)
}

fn int(x: f64) -> Fl {
    Fl::from_f64(x)
}

fn ln_fl(x: &Fl) -> B {
    ln(&B::exact(x.clone()))
}

fn complement(v: &Val) -> Val {
    match v {
        Val::Zero => Val::Num(B::one()),
        Val::Num(b) => Val::Num(B::one().sub(b)),
        Val::Log(l) => Val::Num(B::one().sub(&exp(l))),
    }
}

// ---------------------------------------------------------------- binomial
/// (P(X <= k), P(X > k)) for X ~ Bin(n, p), 0 <= k < n, 0 < p < 1: the lower tail is I_(1-p)(n-k, k+1), i.e. a beta
/// lower tail at the exact distances q = 1 - p and p to the ends.
fn binom_tails(k: &Fl, n: &Fl, p: f64) -> Tails {
    let a = n.sub(k);
    let b = k.add(&one());
    let q = Rat::int(1).sub(&Rat::f(p));
    // vx = ln(x b / ((1-x) a)) at x = q
    let vx = q.mul(&Rat::fl(b.clone())).div(&Rat::f(p).mul(&Rat::fl(a.clone()))).ln();
    beta_tails(&B::exact(a), &B::exact(b), &vx)
}

/// ln of the binomial mass: C(n,k) p^k q^(n-k) = t^(k+1) (1-t)^(n-k+1) / B(k+1, n-k+1) / (p q (n+1)) at t = p.
fn binom_log_mass(k: &Fl, n: &Fl, p: f64) -> B {
    let a = k.add(&one());
    let b = n.sub(k).add(&one());
    let q = Rat::int(1).sub(&Rat::f(p));
    let vx = Rat::f(p).mul(&Rat::fl(b.clone())).div(&q.mul(&Rat::fl(a.clone()))).ln();
    beta_log_mass(&B::exact(a), &B::exact(b), &vx).sub(&ln(&B::f(p))).sub(&ln(&q.ball())).sub(&ln_fl(&n.add(&one())))
}

/// P(X <= k) (`upper`: P(X > k)) for 0 <= k <= n, 0 <= p <= 1.
pub fn binom_cdf(k: f64, n: f64, p: f64, upper: bool) -> R {
    let (k, n) = (int(k), int(n));
    if k == n || p == 0.0 {
        return Ok(if upper { 0.0 } else { 1.0 });
    }
    if p == 1.0 {
        return Ok(if upper { 1.0 } else { 0.0 });
    }
    certified_prob(|| {
        let t = binom_tails(&k, &n, p);
        if upper { t.upper } else { t.lower }
    })
}

pub fn binom_pmf(k: f64, n: f64, p: f64) -> R {
    if p == 0.0 || p == 1.0 {
        let at = if p == 0.0 { 0.0 } else { n };
        return Ok(if k == at { 1.0 } else { 0.0 });
    }
    let (k, n) = (int(k), int(n));
    certified_prob(|| Val::Log(binom_log_mass(&k, &n, p)))
}

/// P(s <= X <= s2), 0 <= s <= s2 <= n: up to 64 masses summed (log-sum), otherwise a difference of the two tails on
/// the side of the range away from the mean, or one minus both outer tails when the range holds the mean.
pub fn binom_range(n: f64, p: f64, s: f64, s2: f64) -> R {
    if p == 0.0 || p == 1.0 {
        let at = if p == 0.0 { 0.0 } else { n };
        return Ok(if s <= at && at <= s2 { 1.0 } else { 0.0 });
    }
    let (nf, sf, s2f) = (int(n), int(s), int(s2));
    if s2 - s < 64.0 {
        return certified_prob(|| {
            let mut i = sf.clone();
            let mut acc: Option<B> = None;
            while i.cmp(&s2f) != Ordering::Greater {
                let m = binom_log_mass(&i, &nf, p);
                acc = Some(match acc {
                    None => m,
                    Some(a) => super::ball::logaddexp(&a, &m),
                });
                i = i.add(&one());
            }
            Val::Log(acc.expect("a nonempty range"))
        });
    }
    let mean = Rat::f(n).mul(&Rat::f(p));
    let below = |x: &Fl| Rat::fl(x.clone()).cmp(&mean) != Ordering::Greater;
    let before = sf.sub(&one());
    certified_prob(|| {
        let lower_at = |x: &Fl| -> (Val, Val) {
            if x.is_neg() {
                return (Val::Zero, Val::Num(B::one()));
            }
            if *x == nf {
                return (Val::Num(B::one()), Val::Zero);
            }
            let t = binom_tails(x, &nf, p);
            (t.lower, t.upper)
        };
        let ball = |v: &Val| match v {
            Val::Zero => B::zero(),
            Val::Num(b) => b.clone(),
            Val::Log(l) => exp(l),
        };
        if below(&s2f) {
            Val::Num(ball(&lower_at(&s2f).0).sub(&ball(&lower_at(&before).0)))
        } else if !below(&before) {
            Val::Num(ball(&lower_at(&before).1).sub(&ball(&lower_at(&s2f).1)))
        } else {
            Val::Num(B::one().sub(&ball(&lower_at(&before).0)).sub(&ball(&lower_at(&s2f).1)))
        }
    })
}

/// Whether P(X <= k) >= alpha for X ~ Bin(n, p), 0 < p, alpha < 1. Exact separation: P(X <= k) is a multiple of
/// 2^-(e n) (p = m 2^-e with m odd, so every term C(n,i) m^i (2^e - m)^(n-i) / 2^(e n)) and alpha of 2^-f, so a
/// nonzero difference is at least 2^-max(e n, f). An enclosure narrower than that which still holds alpha proves the
/// equality (which counts as reached). For p = 1/2 the symmetry P(X <= (n-1)/2) = 1/2 (n odd) is exact. When the
/// separation needs more than 8192 bits and 8192 do not decide, the comparison is taken as reached (the outstanding
/// proof gate named in the report: a difference below 2^-8000 between a binomial tail and a double).
fn binom_reached(k: &Fl, n: &Fl, p: f64, alpha: f64) -> bool {
    if k.cmp(n) != Ordering::Less {
        return true;
    }
    if p == 0.5 && alpha == 0.5 && k.mul_2exp(1).add(&one()) == *n {
        return true;
    }
    let target = Rat::f(alpha);
    let upper = alpha > 0.5;
    let t_up = Rat::int(1).sub(&target);
    let e = -Fl::from_f64(p).low();
    let f = -Fl::from_f64(alpha).low();
    let sep = n.to_f64() * e as f64;
    let sep = sep.max(f as f64) + 64.0;
    let mut bits = 128u64;
    loop {
        let r = with_prec(bits, || {
            let t = binom_tails(k, n, p);
            let v = if upper { &t.upper } else { &t.lower };
            let b = match v {
                Val::Zero => return Some(Ordering::Less),
                Val::Num(b) => b.clone(),
                Val::Log(l) => exp(l),
            };
            if !b.is_finite() {
                return None;
            }
            let goal = if upper { &t_up } else { &target };
            if b.rad.is_zero() {
                return Some(Rat::fl(b.mid.clone()).cmp(goal));
            }
            if Rat::fl(b.lo()).cmp(goal) == Ordering::Greater {
                Some(Ordering::Greater)
            } else if Rat::fl(b.hi()).cmp(goal) == Ordering::Less {
                Some(Ordering::Less)
            } else {
                None
            }
        });
        match r {
            // reached: P(X <= k) >= alpha, i.e. P(X > k) <= 1 - alpha on the upper side
            Some(o) => return if upper { o != Ordering::Greater } else { o != Ordering::Less },
            None if bits as f64 >= sep || bits >= 8192 => return true,
            None => bits *= 2,
        }
    }
}

/// BINOM.INV: the smallest k in [0, n] with P(X <= k) >= alpha; `guess` is checked (k reached, k - 1 not) before a
/// certified integer bisection is run.
pub fn binom_inv(n: f64, p: f64, alpha: f64, guess: Option<f64>) -> f64 {
    let nf = int(n);
    if let Some(g) = guess {
        let gf = int(g);
        if binom_reached(&gf, &nf, p, alpha) && (g == 0.0 || !binom_reached(&gf.sub(&one()), &nf, p, alpha)) {
            return g;
        }
    }
    let (mut lo, mut hi) = (0.0_f64, n);
    while lo < hi {
        let mid = lo + ((hi - lo) / 2.0).floor();
        if binom_reached(&int(mid), &nf, p, alpha) {
            hi = mid;
        } else {
            lo = mid + 1.0;
        }
    }
    lo
}

// ---------------------------------------------------------------- negative binomial
/// P(X <= k) for X failures before the r-th success, 0 < p < 1: I_p(r, k+1).
pub fn negbin_cdf(k: f64, r: f64, p: f64) -> R {
    let (k, r) = (int(k), int(r));
    certified_prob(|| {
        let b = k.add(&one());
        let q = Rat::int(1).sub(&Rat::f(p));
        let vx = Rat::f(p).mul(&Rat::fl(b.clone())).div(&q.mul(&Rat::fl(r.clone()))).ln();
        beta_tails(&B::exact(r.clone()), &B::exact(b), &vx).lower
    })
}

/// C(k+r-1, k) p^r q^k = [p^r q^(k+1) / B(r, k+1)] / ((k + r) q).
pub fn negbin_pmf(k: f64, r: f64, p: f64) -> R {
    let (k, r) = (int(k), int(r));
    certified_prob(|| {
        let b = k.add(&one());
        let q = Rat::int(1).sub(&Rat::f(p));
        let vx = Rat::f(p).mul(&Rat::fl(b.clone())).div(&q.mul(&Rat::fl(r.clone()))).ln();
        Val::Log(beta_log_mass(&B::exact(r.clone()), &B::exact(b), &vx).sub(&ln_fl(&k.add(&r))).sub(&ln(&q.ball())))
    })
}

// ---------------------------------------------------------------- Poisson
/// P(X <= k) = Q(k+1, lambda).
pub fn poisson_cdf(k: f64, lambda: f64) -> R {
    if lambda == 0.0 {
        return Ok(1.0);
    }
    let a = int(k).add(&one());
    certified_prob(|| {
        let vx = Rat::f(lambda).div(&Rat::fl(a.clone())).ln();
        gamma_tails(&B::exact(a.clone()), &vx).upper
    })
}

/// lambda^k e^-lambda / k! = [lambda^(k+1) e^-lambda / Gamma(k+1)] / lambda.
pub fn poisson_pmf(k: f64, lambda: f64) -> R {
    if lambda == 0.0 {
        return Ok(if k == 0.0 { 1.0 } else { 0.0 });
    }
    let a = int(k).add(&one());
    certified_prob(|| {
        let vx = Rat::f(lambda).div(&Rat::fl(a.clone())).ln();
        Val::Log(gamma_log_mass(&B::exact(a.clone()), &vx).sub(&ln(&B::f(lambda))))
    })
}

// ---------------------------------------------------------------- hypergeometric
/// A 2x2 table with margins K, M = N - K (successes / failures in the population) and n, N - n (sample / rest).
struct Table {
    kk: Fl,
    m: Fl,
    n: Fl,
    pop: Fl,
}

impl Table {
    /// The cells at k: (k, K - k, n - k, M - n + k) and their signs in k.
    fn cells(&self, k: &Fl) -> [Fl; 4] {
        [k.clone(), self.kk.sub(k), self.n.sub(k), self.m.sub(&self.n).add(k)]
    }
}

const SIGNS: [i64; 4] = [1, -1, -1, 1];

/// ln P(X = k) in the cell-divergence form (no cancelling terms of order N ln N): with expected cells E = row col / N,
/// delta = (kN - nK)/N and the Stirling form ln x! = (x + 1/2) ln x - x + ln(2 pi)/2 + rem(x) (x >= 1),
/// `ln P = -sum_c (delta_c^2/E_c + O_c log1pmx(delta_c/E_c)) + (1/2) ln(K M n (N-n) / (N prod O_c))`
/// `+ (3 - #nonzero cells) ln(2 pi)/2 + sum_margins rem - sum_cells rem - rem(N)`; an empty cell contributes E_c alone
/// (its ln 0! = 0). Every margin is at least one (a zero margin is a one-point support, decided by the caller).
fn hyper_log_mass(t: &Table, k: &Fl) -> B {
    let cells = t.cells(k);
    let nn = Rat::fl(t.pop.clone());
    let rows = [&t.kk, &t.kk, &t.m, &t.m];
    let cols = [&t.n, &t.pop.sub(&t.n), &t.n, &t.pop.sub(&t.n)];
    let delta = Rat::fl(k.mul(&t.pop).sub(&t.n.mul(&t.kk))).div(&nn);
    let mut div = B::zero();
    let mut nonzero = 0i64;
    let mut prod_o = one();
    let mut rem = B::zero();
    for (i, o) in cells.iter().enumerate() {
        let e = Rat::fl(rows[i].mul(cols[i])).div(&nn);
        if o.is_zero() {
            div = div.add(&e.ball());
            continue;
        }
        nonzero += 1;
        prod_o = prod_o.mul(o);
        rem = rem.sub(&stirling_rem(&B::exact(o.clone())));
        let dc = if SIGNS[i] > 0 { delta.clone() } else { delta.neg() };
        let d = dc.div(&e);
        let small = d.n.is_zero() || d.n.top() < d.d.top() - 1;
        let term = if small {
            dc.mul(&dc).div(&e).ball().add(&B::exact(o.clone()).mul(&log1pmx(&d.ball())))
        } else {
            B::exact(o.clone()).mul(&ln(&Rat::fl(o.clone()).div(&e).ball())).sub(&dc.ball())
        };
        div = div.add(&term);
    }
    let margins = [&t.kk, &t.m, &t.n, &t.pop.sub(&t.n)];
    let mut prod_m = one();
    for m in margins {
        prod_m = prod_m.mul(m);
        rem = rem.add(&stirling_rem(&B::exact(m.clone())));
    }
    rem = rem.sub(&stirling_rem(&B::exact(t.pop.clone())));
    let half_ln = ln(&Rat { n: prod_m, d: prod_o.mul(&t.pop) }.ball()).mul_2exp(-1);
    div.neg().add(&half_ln).add(&half_ln_2pi().mul_int(3 - nonzero)).add(&rem)
}

/// The log mass as a function of a real k (every factorial a log gamma): `G(x) = -sum_c lnGamma(z_c(x))`,
/// z_c = cell_c(x) + 1. Concave; its integer values differ from ln P by a constant.
struct HyperF<'a> {
    t: &'a Table,
}

impl HyperF<'_> {
    /// z_c(x) as balls: [x + 1, K - x + 1, n - x + 1, M - n + x + 1], their midpoints exact (a rounded K - x would
    /// lose the position of x among counts of 1e99).
    fn z(&self, x: &B) -> [B; 4] {
        let t = self.t;
        let e = |mid: Fl| B { mid, rad: x.rad };
        let xm = &x.mid;
        [e(xm.add(&one())), e(t.kk.sub(xm).add(&one())), e(t.n.sub(xm).add(&one())), e(t.m.sub(&t.n).add(xm).add(&one()))]
    }

    /// `ln(z1 z4 / (z2 z3))` = sum_c s_c ln z_c over a ball of x. z1 z4 - z2 z3 is linear in x,
    /// `(N + 4) x + (M - n + 1) - (K + 1)(n + 1)`, formed exactly at the midpoint (its radius times N + 4), so the
    /// logarithm keeps relative accuracy near the mode where the four logarithms cancel.
    fn ln_ratio(&self, x: &B) -> B {
        let t = self.t;
        let c0 = t.m.sub(&t.n).add(&one()).sub(&t.kk.add(&one()).mul(&t.n.add(&one())));
        let slope = t.pop.add(&Fl::from_i64(4));
        let delta = B { mid: slope.mul(&x.mid).add(&c0), rad: Mag::of(&slope).mul(x.rad) };
        let z = self.z(x);
        let den = z[1].mul(&z[2]);
        let q = delta.div(&den);
        if q.abs_hi().top() < -1 { log1p(&q) } else { ln(&z[0].mul(&z[3])).sub(&ln(&den)) }
    }

    /// `sum_c s_c psi(z_c)` = ln_ratio + sum_c s_c (psi - ln)(z_c).
    fn psi_sum(&self, x: &B) -> B {
        let z = self.z(x);
        let mut s = self.ln_ratio(x);
        for (i, zc) in z.iter().enumerate() {
            let p = psi_tilde(zc);
            s = if SIGNS[i] > 0 { s.add(&p) } else { s.sub(&p) };
        }
        s
    }
}

/// The largest series order of the log-gamma differences in `HyperF::diff`.
const DIFF_TERMS: i64 = 40;

impl Family for HyperF<'_> {
    /// G(v0 + d) - G(v0) = -sum_c [lnGamma(z_c + s_c d) - lnGamma(z_c)]. When every z_c >= 2^16 and |d| <= z_c/32, the
    /// Taylor series `d sum_c s_c psi(z_c) + sum_{j>=2} sum_c (-1)^j zeta(j, z_c) (s_c d)^j / j` (first order through
    /// `psi_sum`, no cancellation) with the tail after order J bounded by `4 z rho^(J+1) / (J+1)`, rho = |d|/z
    /// (zeta(j, z) <= 2 z^(1-j)); otherwise the four log-gamma differences at a precision raised by the cancellation.
    fn diff(&self, v0: &B, d: &B) -> B {
        if d.is_exact_zero() {
            return B::zero();
        }
        let z = self.z(v0);
        let p = prec() as i64;
        let dtop = d.abs_hi().top();
        let need = p + 24 + dtop.max(0) + 2;
        // per cell: rho <= 2^-gap with gap = top(z) - top(d) - 1; the series cells and the others
        let gap: Vec<i64> = z.iter().map(|zc| zc.abs_lo().top() - dtop - 1).collect();
        let series: Vec<bool> = (0..4).map(|i| z[i].abs_lo().top() >= 16 && gap[i] >= 5 && need / gap[i] < DIFF_TERMS && z[i].rad.is_zero()).collect();
        let mut s = B::zero();
        if series.iter().any(|&b| b) {
            // first order: d sum_S s_c psi(z_c) = d [ln prod_S z_c^(s_c) (exact quotient) + sum_S s_c (psi - ln)(z_c)]
            let (mut num, mut den) = (one(), one());
            let mut first = B::zero();
            for i in (0..4).filter(|&i| series[i]) {
                let pt = psi_tilde(&z[i]);
                if SIGNS[i] > 0 {
                    num = num.mul(&z[i].mid);
                    first = first.add(&pt);
                } else {
                    den = den.mul(&z[i].mid);
                    first = first.sub(&pt);
                }
            }
            s = d.mul(&Rat { n: num, d: den }.ln().add(&first));
            let mut tail = Mag::ZERO;
            for i in (0..4).filter(|&i| series[i]) {
                let jmax = need / gap[i] + 1;
                let zs = hurwitz_all(&z[i], jmax);
                let sd = if SIGNS[i] > 0 { d.clone() } else { d.neg() };
                let mut pw = sd.clone();
                for j in 2..=jmax {
                    pw = pw.mul(&sd);
                    let term = zs[(j - 2) as usize].mul(&pw).div_int(j);
                    s = if j % 2 == 0 { s.add(&term) } else { s.sub(&term) };
                }
                // 4 z rho^(J+1) / (J+1) <= 4 |d| rho^J
                tail = tail.add(d.abs_hi().mul(Mag::pow2(-gap[i] * jmax)).mul_2exp(2));
            }
            s = B { mid: s.mid, rad: s.rad.add(tail) };
        }
        let direct: Vec<usize> = (0..4).filter(|&i| !series[i]).collect();
        if !direct.is_empty() {
            let ztop = direct.iter().map(|&i| z[i].mid.top()).max().unwrap_or(0);
            let extra = (16 + (ztop - dtop).max(0)).min(1200) as u64;
            let t = with_prec(prec() + extra, || {
                let mut t = B::zero();
                for &i in &direct {
                    let mid = if SIGNS[i] > 0 { z[i].mid.add(&d.mid) } else { z[i].mid.sub(&d.mid) };
                    let zd = B { mid, rad: z[i].rad.add(d.rad) };
                    t = t.add(&lgamma(&zd).sub(&lgamma(&z[i])));
                }
                t
            });
            s = s.add(&t);
        }
        s.neg()
    }

    /// G^(j)(v)/j!: j = 1 is `-psi_sum`; j >= 2 is `-sum_c (-s_c)^j zeta(j, z_c) / j`.
    fn coeffs(&self, v: &B, m: usize) -> Vec<B> {
        let mut out = vec![self.psi_sum(v).neg()];
        if m < 2 {
            return out;
        }
        let z = self.z(v);
        let zs: Vec<Vec<B>> = z.iter().map(|zc| hurwitz_all(zc, m as i64)).collect();
        for j in 2..=m {
            let mut s = B::zero();
            for (i, zz) in zs.iter().enumerate() {
                let t = zz[j - 2].div_int(j as i64);
                // (-s_c)^j: +1 for even j, -s_c for odd j
                let plus = j % 2 == 0 || SIGNS[i] < 0;
                s = if plus { s.add(&t) } else { s.sub(&t) };
            }
            out.push(s.neg());
        }
        out
    }
}

/// The hypergeometric support [lo, hi] for a sample of n from N with K successes.
fn support(t: &Table) -> (Fl, Fl) {
    let lo = t.n.sub(&t.m);
    let lo = if lo.is_neg() { Fl::zero() } else { lo };
    let hi = if t.n.cmp(&t.kk) == Ordering::Less { t.n.clone() } else { t.kk.clone() };
    (lo, hi)
}

fn table(n: f64, kk: f64, pop: f64) -> Table {
    let (kk, n, pop) = (int(kk), int(n), int(pop));
    Table { m: pop.sub(&kk), kk, n, pop }
}

/// P(X = k) for k inside the support of a table whose support has more than one point.
pub fn hypgeom_pmf(k: f64, n: f64, kk: f64, pop: f64) -> R {
    let t = table(n, kk, pop);
    let k = int(k);
    let (lo, hi) = support(&t);
    if lo == hi {
        return Ok(1.0);
    }
    certified_prob(|| Val::Log(hyper_log_mass(&t, &k)))
}

/// P(X <= k) for lo <= k < hi. The terms fall on both sides of the mode (log-concave), and the ratio
/// P(k+1)/P(k) = (K-k)(n-k) / ((k+1)(M-n+k+1)) decides exactly which side of it k is on: at or past it the upper tail
/// from k+1 is summed (and the lower is its complement), before it the lower tail from k downward.
pub fn hypgeom_cdf(k: f64, n: f64, kk: f64, pop: f64) -> R {
    let t = table(n, kk, pop);
    let k = int(k);
    let (lo, hi) = support(&t);
    let c = t.cells(&k);
    let up = c[1].mul(&c[2]);
    let down = k.add(&one()).mul(&c[3].add(&one()));
    let past_mode = up.cmp(&down) != Ordering::Greater;
    certified_prob(|| {
        let fam = HyperF { t: &t };
        if past_mode {
            let k1 = k.add(&one());
            let s = lattice_log(&fam, &B::exact(k1.clone()), 1, &hi.sub(&k));
            complement(&Val::Log(hyper_log_mass(&t, &k1).add(&s)))
        } else {
            let s = lattice_log(&fam, &B::exact(k.clone()), -1, &k.sub(&lo).add(&one()));
            Val::Log(hyper_log_mass(&t, &k).add(&s))
        }
    })
}
