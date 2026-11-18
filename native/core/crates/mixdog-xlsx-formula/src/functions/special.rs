//! Special-function kernels for the distribution functions: log-gamma, the regularized incomplete gamma
//! function P/Q and the regularized incomplete beta function I/complement. Each of the pairs is evaluated on its own
//! side (series or continued fraction), the small tail is never formed as `1 - big`, and a series or fraction that
//! does not converge is an error, never a truncated value.

use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialError {
    Domain,
    NoConvergence,
}

type R<T> = Result<T, SpecialError>;

/// Convergence of a continued-fraction factor: a few units in the last place (the factor jitters at that level).
const CONV: f64 = 4.0 * f64::EPSILON;
const MAX_ITER: usize = 1_000_000;
/// Consecutive continued-fraction factors within [`CONV`] of 1 that end the iteration.
const SETTLED: usize = 8;
const TINY: f64 = 1e-300;
const LN_SQRT_2PI: f64 = 0.918_938_533_204_672_8;
/// Arguments at or above this use the Stirling series directly (its first omitted term is below 1e-17 here).
const STIRLING_MIN: f64 = 10.0;

/// The Stirling remainder: `ln Γ(z) = (z-½)ln z - z + ½ln 2π + stirling_corr(z)`.
fn stirling_corr(z: f64) -> f64 {
    let r = 1.0 / z;
    let r2 = r * r;
    r * (1.0 / 12.0
        + r2 * (-1.0 / 360.0
            + r2 * (1.0 / 1260.0
                + r2 * (-1.0 / 1680.0
                    + r2 * (1.0 / 1188.0
                        + r2 * (-691.0 / 360360.0 + r2 * (1.0 / 156.0 + r2 * (-3617.0 / 122400.0))))))))
}

fn stirling(z: f64) -> f64 {
    (z - 0.5) * z.ln() - z + LN_SQRT_2PI + stirling_corr(z)
}

/// `ln Γ(x)` for `x > 0`: the Stirling series, with the argument shifted up by the recurrence below 10. Around its
/// zeros at 1 and 2 (`|x-1| < 1/4`, `|x-2| < 1/4`) the Taylor series at 1 is used (`ln Γ(2+ε) = ln Γ(1+ε) + ln(1+ε)`),
/// so the value is exactly 0 there and keeps full relative precision close by.
pub fn ln_gamma(x: f64) -> f64 {
    if (x - 1.0).abs() < SMALL_A {
        return ln_gamma_1p_small(x - 1.0);
    }
    if (x - 2.0).abs() < SMALL_A {
        return ln_gamma_1p_small(x - 2.0) + (x - 2.0).ln_1p();
    }
    if x >= STIRLING_MIN {
        return stirling(x);
    }
    let mut z = x;
    let mut prod = 1.0;
    while z < STIRLING_MIN {
        prod *= z;
        z += 1.0;
    }
    stirling(z) - prod.ln()
}

/// `ln(1+d) - d`, without cancellation for small `|d|`.
fn log1pmx(d: f64) -> f64 {
    if d.abs() >= 0.5 {
        return d.ln_1p() - d;
    }
    // -d²/2 + d³/3 - d⁴/4 + …
    let mut pow = d * d;
    let mut sum = -0.5 * pow;
    let mut k = 2.0;
    loop {
        pow *= -d;
        k += 1.0;
        let term = -pow / k;
        sum += term;
        // a NaN term ends the loop too
        if term.is_nan() || term.abs() <= 1e-18 * sum.abs() {
            return sum;
        }
    }
}

/// `ln(r) - (r-1)` for `r = 1 + d` where the caller supplies both `r` and `d` exactly: near `r = 0` (`d` near -1)
/// `ln_1p(d)` would lose the digits of `r`, so the logarithm is taken of `r` itself.
fn log_ratio_mx(r: f64, d: f64) -> f64 {
    if d.abs() < 0.5 { log1pmx(d) } else { r.ln() - d }
}

/// `x^a e^-x / Γ(a)`. For large `a` the exponent is the saddle-point form, so no large terms cancel.
pub fn gamma_pref(a: f64, x: f64) -> f64 {
    if a >= STIRLING_MIN {
        (a / (2.0 * PI)).sqrt() * (a * log_ratio_mx(x / a, (x - a) / a) - stirling_corr(a)).exp()
    } else {
        (a * x.ln() - x - ln_gamma(a)).exp()
    }
}


/// `erf(x)`: for `|x| < 1` the series `2/√π e^(-x²) Σ 2^n x^(2n+1)/(2n+1)!!` (positive terms, no cancellation),
/// otherwise `1 - erfc` (`erfc(1) = 0.157`: under one digit is cancelled).
pub fn erf(x: f64) -> f64 {
    let ax = x.abs();
    let v = if ax < 1.0 {
        let x2 = ax * ax;
        let mut term = ax;
        let mut sum = ax;
        let mut n = 0.0;
        while term > 1e-18 * sum {
            n += 1.0;
            term *= 2.0 * x2 / (2.0 * n + 1.0);
            sum += term;
        }
        2.0 / PI.sqrt() * exp_neg_square(ax) * sum
    } else {
        1.0 - erfc(ax)
    };
    v.copysign(x)
}

/// `e^(-x²)` with the square formed exactly as a double-double, so the argument carries no rounding error.
pub fn exp_neg_square(x: f64) -> f64 {
    // e^(-x²) is below the smallest subnormal from |x| = 27.3
    if x.abs() > 27.3 {
        return 0.0;
    }
    let h = x * x;
    (-h).exp() * (1.0 - x.mul_add(x, -h))
}

/// `erfc(x)` with relative precision over the whole range: `1 - erf` below 1, and for `x >= 1` the continued fraction
/// `e^(-x²)/(√π (x + (1/2)/(x + 1/(x + (3/2)/(x + …)))))` evaluated backwards from depth `210/x²` (the truncation
/// error is about `exp(-2x√(2·depth)) < 1e-30`).
pub fn erfc(x: f64) -> f64 {
    if x < 0.0 {
        return 2.0 - erfc(-x);
    }
    if x < 1.0 {
        return 1.0 - erf(x);
    }
    let mut t = x;
    for i in (1..=(210.0 / (x * x)).ceil() as u32 + 5).rev() {
        t = x + 0.5 * f64::from(i) / t;
    }
    exp_neg_square(x) / (PI.sqrt() * t)
}


/// `Φ(z) = ½ erfc(-z/√2)`, each tail with its own relative precision.
pub fn norm_cdf(z: f64) -> f64 {
    0.5 * erfc(-z / std::f64::consts::SQRT_2)
}

/// `Φ⁻¹(p)` for `0 < p < 1`: the Abramowitz-Stegun 26.2.23 start (error 4.5e-4) refined by Halley steps on
/// `Φ(z) - p` with `Φ` from [`erfc`] (a relative 1e-15 in either tail), so a probability far in a tail keeps its
/// quantile to full precision; `p > 1/2` uses `Φ⁻¹(p) = -Φ⁻¹(1-p)` (`1 - p` is exact there).
pub fn norm_quantile(p: f64) -> f64 {
    if p > 0.5 {
        return -norm_quantile(1.0 - p);
    }
    if p == 0.5 {
        return 0.0;
    }
    let t = (-2.0 * p.ln()).sqrt();
    let mut z = -(t - (2.30753 + 0.27061 * t) / (1.0 + t * (0.99229 + 0.04481 * t)));
    for _ in 0..10 {
        let h = z * z;
        let density = (-0.5 * h).exp() * (1.0 - 0.5 * z.mul_add(z, -h)) / 2.506_628_274_631_000_2;
        let u = (norm_cdf(z) - p) / density;
        let step = u / (1.0 + 0.5 * z * u);
        z -= step;
        if step.abs() <= 1e-16 * z.abs() {
            break;
        }
    }
    z
}
/// Temme's uniform expansion (Temme 1979; DLMF 8.12) is used from this shape: its truncation after `a^-6` is below
/// `1e-17` relative (checked against mpmath at `a = 100` and `|η| <= 0.3`, error 4e-18, falling like `a^-7`).
const TEMME_MIN_A: f64 = 100.0;
const TEMME_MAX_ETA: f64 = 0.3;
/// Taylor coefficients in `η` (powers 0..18) of `c_0 … c_6` of DLMF 8.12.8, `c_0 = 1/(λ-1) - 1/η`,
/// `c_k = c_{k-1}'/η + (-1)^k γ_k/(λ-1)`, generated in exact rational arithmetic from the series of `λ(η)`; the
/// radius of convergence is 2√π, so 18 terms at `|η| < 0.3` leave under `1e-29`.
const TEMME_C: [[f64; 18]; 7] = [
    [-0.3333333333333333, 0.08333333333333333, -0.014814814814814815, 0.0011574074074074073, 0.0003527336860670194, -0.0001787551440329218, 3.919263178522438e-05, -2.185448510679992e-06, -1.85406221071516e-06, 8.296711340953087e-07, -1.7665952736826078e-07, 6.707853543401498e-09, 1.0261809784240309e-08, -4.382036018453353e-09, 9.147699582236791e-10, -2.5514193994946248e-11, -5.830772132550426e-11, 2.4361948020667415e-11],
    [-0.001851851851851852, -0.003472222222222222, 0.0026455026455026454, -0.0009902263374485596, 0.00020576131687242798, -4.018775720164609e-07, -1.8098550334489977e-05, 7.64916091608111e-06, -1.6120900894563446e-06, 4.647127802807434e-09, 1.378633446915721e-07, -5.752545603517705e-08, 1.1951628599778148e-08, -1.7543241719747647e-11, -1.0091543710600413e-09, 4.1627929918425823e-10, -8.56390702649298e-11, 6.067215101604758e-14],
    [0.004133597883597883, -0.0026813271604938273, 0.0007716049382716049, 2.0093878600823047e-06, -0.0001073665322636516, 5.2923448829120125e-05, -1.2760635188618728e-05, 3.423578734096138e-08, 1.3721957309062934e-06, -6.298992138380055e-07, 1.4280614206064242e-07, -2.0477098421990866e-10, -1.409252991086752e-08, 6.228974084922022e-09, -1.3670488396617114e-09, 9.428356159014678e-13, 1.2872252400089318e-10, -5.564595613436332e-11],
    [0.0006494341563786008, 0.00022947209362139917, -0.0004691894943952557, 0.00026772063206283885, -7.561801671883977e-05, -2.396505113867297e-07, 1.1082654115347302e-05, -5.6749528269915965e-06, 1.4230900732435883e-06, -2.7861080291528143e-11, -1.6958404091930278e-07, 8.099464905388083e-08, -1.9111168485973655e-08, 2.3928620439808118e-12, 2.06201318154888e-09, -9.460496661855133e-10, 2.154104977577491e-10, -1.388823336813903e-14],
    [-0.0008618882909167117, 0.0007840392217200666, -0.0002990724803031902, -1.4638452578843418e-06, 6.641498215465122e-05, -3.968365047179435e-05, 1.1375726970678419e-05, 2.507497226237533e-10, -1.6954149536558305e-06, 8.907507532205309e-07, -2.292934834000805e-07, 2.956794137544049e-11, 2.8865829742708783e-08, -1.4189739437803219e-08, 3.4463580499464896e-09, -2.3024517174528067e-13, -3.9409233028046403e-10, 1.8602338968504504e-10],
    [-0.00033679855336635813, -6.972813758365857e-05, 0.0002772753244959392, -0.00019932570516188847, 6.797780477937208e-05, 1.419062920643967e-07, -1.3594048189768693e-05, 8.018470256334202e-06, -2.291481176508095e-06, -3.252473551298454e-10, 3.4652846491085265e-07, -1.8447187191171344e-07, 4.8240967037894184e-08, -1.7989466721743514e-14, -6.306194500013524e-09, 3.162417628774568e-09, -7.840924253697429e-10, 5.1926791652540416e-15],
    [0.0005313079364639922, -0.0005921664373536939, 0.0002708782096718045, 7.902353232660328e-07, -8.153969367561969e-05, 5.61168275310625e-05, -1.8329116582843375e-05, -3.0796134506033047e-09, 3.465155368803609e-06, -2.0291327396058603e-06, 5.788792863149004e-07, 2.338630673826657e-13, -8.828600746330483e-08, 4.7435958880408125e-08, -1.2545415020710383e-08, 8.649648858010293e-14, 1.6846058979264062e-09, -8.575492823577595e-10],
];

/// `(P, Q)` from Temme's expansion `Q = ½erfc(η√(a/2)) + R`, `P = ½erfc(-η√(a/2)) - R` with
/// `R = e^(-aη²/2)/√(2πa) · Σ c_k(η) a^-k` and `½η² = λ - 1 - ln λ`, `λ = x/a`; the tail on the side of the
/// erfc argument that is positive is formed directly and the other as its complement (at most 1/2 of cancellation
/// by one bit). `None` outside `|η| < 0.3`, where the series and the fraction converge in a few hundred terms.
fn gamma_temme(a: f64, x: f64) -> Option<(f64, f64)> {
    let d = (x - a) / a;
    if d.abs() >= 0.5 {
        return None;
    }
    let m = -log1pmx(d);
    let eta = (2.0 * m).sqrt().copysign(d);
    if eta.abs() >= TEMME_MAX_ETA {
        return None;
    }
    let mut s = 0.0;
    let mut ak = 1.0;
    for row in &TEMME_C {
        s += row.iter().rev().fold(0.0, |h, c| h * eta + c) * ak;
        ak /= a;
    }
    let r = (-a * m).exp() / (2.0 * PI * a).sqrt() * s;
    let small = 0.5 * erfc(eta.abs() * (a / 2.0).sqrt());
    Some(if eta > 0.0 {
        let q = small + r;
        (1.0 - q, q)
    } else {
        let p = small - r;
        (p, 1.0 - p)
    })
}


/// Regularized incomplete gamma `(P(a,x), Q(a,x))`, `a > 0`, `x >= 0`.
pub fn gamma_inc(a: f64, x: f64) -> R<(f64, f64)> {
    if a.is_nan() || x.is_nan() || a <= 0.0 || x < 0.0 || a.is_infinite() {
        return Err(SpecialError::Domain);
    }
    if x == 0.0 {
        return Ok((0.0, 1.0));
    }
    if x.is_infinite() {
        return Ok((1.0, 0.0));
    }
    if a >= TEMME_MIN_A
        && let Some(t) = gamma_temme(a, x)
    {
        return Ok(t);
    }
    if x < a + 1.0 {
        let p = gamma_p_series(a, x)?;
        let q = if a < SMALL_A { gamma_q_small_a(a, x) } else { 1.0 - p };
        Ok((p, q))
    } else {
        let q = gamma_q_fraction(a, x)?;
        Ok((1.0 - q, q))
    }
}

/// `P(a,x) = x^a e^-x/Γ(a) · Σ x^n / (a(a+1)…(a+n))`.
fn gamma_p_series(a: f64, x: f64) -> R<f64> {
    let mut term = 1.0 / a;
    let mut sum = term;
    let mut n = a;
    for _ in 0..MAX_ITER {
        n += 1.0;
        term *= x / n;
        sum += term;
        // the terms fall by the factor x/(n+1) < 1 from here on, so the rest is at most `term·ρ/(1-ρ)`
        let rho = x / (n + 1.0);
        if term * rho / (1.0 - rho) < sum * 0.5 * f64::EPSILON {
            return Ok(sum * gamma_pref(a, x));
        }
    }
    Err(SpecialError::NoConvergence)
}

/// ζ(2) … ζ(30), for the Taylor series of `ln Γ(1+a)` at `a = 0`.
const ZETA: [f64; 29] = [
    1.6449340668482264,
    1.2020569031595942,
    1.0823232337111381,
    1.03692775514337,
    1.0173430619844492,
    1.008349277381923,
    1.0040773561979444,
    1.0020083928260821,
    1.000994575127818,
    1.0004941886041194,
    1.000246086553308,
    1.0001227133475785,
    1.0000612481350588,
    1.000030588236307,
    1.0000152822594086,
    1.0000076371976379,
    1.000003817293265,
    1.0000019082127165,
    1.0000009539620338,
    1.0000004769329869,
    1.0000002384505027,
    1.000000119219926,
    1.000000059608189,
    1.0000000298035034,
    1.0000000149015549,
    1.0000000074507118,
    1.000000003725334,
    1.0000000018626598,
    1.0000000009313275,
];
#[allow(clippy::approx_constant)] // the std constant is not stable
const EULER_GAMMA: f64 = 0.577_215_664_901_532_9;
/// Below this `a`, `Q = 1 - P` would lose the small value and the Taylor form is used instead.
const SMALL_A: f64 = 0.25;

/// `ln Γ(1+a)` for `|a| < 0.25` with full relative precision: `-γa + Σ_{k≥2} ζ(k)(-a)^k/k`.
fn ln_gamma_1p_small(a: f64) -> f64 {
    let mut sum = 0.0;
    let mut pow = -a;
    for (i, z) in ZETA.iter().enumerate() {
        pow *= -a;
        sum += z * pow / (i + 2) as f64;
    }
    -EULER_GAMMA * a + sum
}

/// `Q(a,x)` for `a < 0.25`, `x < a+1`, where `1 - P` would lose the small value: with
/// `P = u·(1 + a Σ_{n≥1} (-x)^n / ((a+n) n!))` and `u = x^a/Γ(a+1)`, `Q = (1-u) - u·a·Σ`.
fn gamma_q_small_a(a: f64, x: f64) -> f64 {
    let t = a * x.ln() - ln_gamma_1p_small(a);
    let u = t.exp();
    let mut term = 1.0;
    let mut sum = 0.0;
    let mut n = 0.0;
    loop {
        n += 1.0;
        term *= -x / n;
        sum += term / (a + n);
        if term.abs() < 1e-18 && n > x {
            break;
        }
    }
    (-t.exp_m1() - u * a * sum).max(0.0)
}

/// `Q(a,x) = x^a e^-x/Γ(a) · 1/(x+1-a- 1(1-a)/(x+3-a- 2(2-a)/(x+5-a- …)))`, modified Lentz.
fn gamma_q_fraction(a: f64, x: f64) -> R<f64> {
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / TINY;
    let mut d = 1.0 / b;
    let mut h = d;
    let mut settled = 0;
    for i in 1..=MAX_ITER {
        let fi = i as f64;
        let an = -fi * (fi - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < TINY {
            d = TINY;
        }
        c = b + an / c;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < CONV {
            settled += 1;
            if settled >= SETTLED {
                return Ok(h * gamma_pref(a, x));
            }
        } else {
            settled = 0;
        }
    }
    Err(SpecialError::NoConvergence)
}

/// `ln B(a,b)`: `ln Γ(lo) - (ln Γ(s) - ln Γ(hi))`, the difference formed without cancellation when `hi` is large.
pub fn ln_beta_fn(a: f64, b: f64) -> f64 {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let s = a + b;
    if hi >= STIRLING_MIN {
        ln_gamma(lo) - ((hi - 0.5) * (lo / hi).ln_1p() + lo * (s.ln() - 1.0) + stirling_corr(s) - stirling_corr(hi))
    } else {
        ln_gamma(a) + ln_gamma(b) - ln_gamma(s)
    }
}

/// `(I_x(a,b), 1 - I_x(a,b))` for an `x` too small to represent (`ln x` is given, `x < 1e-280`): the series is its
/// first term `x^a / (a B(a,b))` to a relative 1e-280.
pub fn beta_inc_tiny(ln_x: f64, a: f64, b: f64) -> R<(f64, f64)> {
    if a.is_nan() || b.is_nan() || ln_x.is_nan() || a <= 0.0 || b <= 0.0 {
        return Err(SpecialError::Domain);
    }
    Ok(((a * ln_x - ln_beta_fn(a, b)).exp() / a, 1.0))
}

/// `x^a y^b / B(a,b)` with `y = 1-x` supplied by the caller (so a tiny `y` keeps its precision).
pub fn beta_pref(a: f64, b: f64, x: f64, y: f64) -> f64 {
    let s = a + b;
    if a.min(b) >= STIRLING_MIN {
        let l1 = a * log_ratio_mx(x * s / a, (x * b - a * y) / a);
        let l2 = b * log_ratio_mx(y * s / b, (y * a - b * x) / b);
        return (a / (2.0 * PI)).sqrt()
            * (b / s).sqrt()
            * (l1 + l2 + stirling_corr(s) - stirling_corr(a) - stirling_corr(b)).exp();
    }
    let ln_beta = ln_beta_fn(a, b);
    // ln of the complement of the smaller one via ln_1p: `1 - x` as a double has an error that `b` would amplify
    let ln_x = if y < 0.5 { (-y).ln_1p() } else { x.ln() };
    let ln_y = if x < 0.5 { (-x).ln_1p() } else { y.ln() };
    (a * ln_x + b * ln_y - ln_beta).exp()
}

/// The continued fraction of `I_x(a,b)`, modified Lentz; `x < (a+1)/(a+b+2)` converges fastest. `y = 1-x` is given
/// exactly: the first denominator `1 - (a+b)x/(a+1)` is formed as `(1 + a y - b x)/(a+1)`, which does not cancel for
/// any `x` below the switch point (the plain form loses `(a+b)/2` ulps there, and more when `x` is near 1, the tail of
/// Student t with a large number of degrees of freedom).
fn beta_fraction(a: f64, b: f64, x: f64, y: f64) -> R<f64> {
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = 1.0;
    let mut d = (1.0 + a * y - b * x) / qap;
    if d.abs() < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut h = d;
    let mut settled = 0;
    for m in 1..=MAX_ITER {
        let mf = m as f64;
        let m2 = 2.0 * mf;
        let aa = mf * (b - mf) * x / ((qam + m2) * (a + m2));
        // `e` and `f` are the deviations of the odd step's denominators from 1; the even step needs them separately
        let e = aa * d;
        d = 1.0 + e;
        if d.abs() < TINY {
            d = TINY;
        }
        let f = aa / c;
        c = 1.0 + f;
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        h *= d * c;
        // The even coefficient is `-x(1+ρ)`, and `1 + aa·d` there is `(e + y - xρ)/(1+e)` (likewise for `c` with `f`):
        // for `x` near 1 the plain form cancels to nothing, this one has no subtraction of near-equal numbers.
        // `ρ·(a+2m)(a+1+2m)` is the exact polynomial `a(b-1) + m(b-2a-2) - 3m²`.
        let rho = (a * (b - 1.0) + mf * (b - 2.0 * a - 2.0) - 3.0 * mf * mf) / ((a + m2) * (qap + m2));
        let core = y - x * rho;
        d = (e + core) / (1.0 + e);
        if d.abs() < TINY {
            d = TINY;
        }
        c = (f + core) / (1.0 + f);
        if c.abs() < TINY {
            c = TINY;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        // A slowly converging fraction has factors within rounding of 1 whose product still matters, so several
        // in a row are required.
        if (del - 1.0).abs() < CONV {
            settled += 1;
            if settled >= SETTLED {
                return Ok(h);
            }
        } else {
            settled = 0;
        }
    }
    Err(SpecialError::NoConvergence)
}

/// `ln Γ(a+b) - ln Γ(a)` for `0 < b < 1` with relative precision even when `b` is far below the ulp of `a`:
/// the Stirling difference is formed from `ln_1p`/`expm1` of `b/z` (z = `a` shifted up to at least 10 by the
/// recurrence, whose terms are `ln_1p(b/(a+k))`), so nothing is subtracted from a large log-gamma.
fn ln_gamma_ratio(a: f64, b: f64) -> f64 {
    let (mut z, mut shift) = (a, 0.0);
    while z < STIRLING_MIN {
        shift += (b / z).ln_1p();
        z += 1.0;
    }
    let u = (b / z).ln_1p();
    const C: [f64; 8] =
        [1.0 / 12.0, -1.0 / 360.0, 1.0 / 1260.0, -1.0 / 1680.0, 1.0 / 1188.0, -691.0 / 360360.0, 1.0 / 156.0, -3617.0 / 122400.0];
    let mut corr = 0.0;
    let mut pow = 1.0 / z;
    let r2 = pow * pow;
    for (k, c) in C.iter().enumerate() {
        corr += c * pow * (-((2 * k + 1) as f64) * u).exp_m1();
        pow *= r2;
    }
    (z - 0.5) * u + b * ((z + b).ln() - 1.0) + corr - shift
}

/// `1 - I_v(B, A)` for a small `B < 0.25` and `v <= 1/2`-ish (the complement of the tail that is nearly 1), as
/// `-expm1(L)` with `L = B ln v + ln Γ(A+B) - ln Γ(A) - ln Γ(1+B) + ln_1p(B·S)`, `S = Σ_{n≥1} (1-A)_n v^n / (n!(B+n))`
/// (from `I_v(B,A) = v^B Σ_{n≥0} (1-A)_n v^n/(n!(B+n)) / B(A,B)`). Every term of `L` is O(B), so the tail keeps its
/// relative precision down to `B = 1e-300`; the relative error is about `eps · (|B ln v| + |lnΓ ratio| + |B S|) / |L|`.
fn beta_small_complement(v: f64, a: f64, b: f64) -> f64 {
    let mut term = 1.0;
    let mut s = 0.0;
    let mut n = 0.0;
    loop {
        n += 1.0;
        term *= v * (n - a) / n;
        s += term / (b + n);
        if term.abs() < 1e-18 && n > a * v + 1.0 {
            break;
        }
    }
    let l = b * v.ln() + ln_gamma_ratio(a, b) - ln_gamma_1p_small(b) + (b * s).ln_1p();
    -l.exp_m1()
}
/// The large-parameter expansion of the incomplete beta function is used when both shapes are at least this.
const ASYM_MIN: f64 = 100.0;
const ASYM_MAX_ETA: f64 = 0.3;
/// Terms `d_0 … d_24` of the expansion; the first omitted term is below `1e-18` relative for `min(a,b) >= 100`
/// (checked against mpmath at 40 digits: `a = b = 100` .. `a = 50, b = 1000` gave 1e-25 .. 1e-18 with 20..30 terms).
const ASYM_TERMS: usize = 24;

/// `(I_x(a,b), 1 - I_x(a,b))` by the uniform expansion in the Gaussian variable `η`
/// (`½Nη² = -(a ln(x/p) + b ln(y/q))`, `N = a+b`, `p = a/N`, `q = b/N`, sign of `η` that of `x-p`), which keeps the
/// distance of `x` from the mean to full relative precision (`x N - a` is formed with `fma`) so that a shape of 1e15
/// costs no accuracy near the centre:
///
/// `I_x = ∫_0^x t^(a-1) (1-t)^(b-1) dt / B = e^(c(N)-c(a)-c(b)) √(N/2π) ∫_{-∞}^{η} e^(-Ns²/2) f(s) ds`
///
/// with `f(s) = √(pq)·s/u(s)`, `u = t - p`, which satisfies `u u' = s(p+u)(q-u)`; its Taylor series
/// `f = Σ d_n s^n` (recurrence below, O(M²)) is integrated term by term against the Gaussian (moments `J_n` by the
/// two-term recurrence `N J_n = (n-1) J_{n-2} ∓ η^(n-1) e^(-Nη²/2)`). The tail on the far side of the mean is formed
/// directly and the other as its complement. Truncation after `s^24` is below `1e-18` relative for both shapes at least
/// 100 and `|η| < 0.3`; the rounding error is a few ulps plus `eps` times the exponent `Nη²/2`.
#[allow(clippy::needless_range_loop)] // d[n] is built from d[n-1] .. d[0]
fn beta_asym(x: f64, y: f64, a: f64, b: f64) -> Option<(f64, f64)> {
    let nh = a + b;
    let bb = nh - a;
    let nl = (a - (nh - bb)) + (b - bb);
    // delta = x N - a = b - y N, to one rounding
    let delta = if x <= y {
        let t = x * nh;
        (t - a) + x.mul_add(nh, -t) + x * nl
    } else {
        let t = y * nh;
        (b - t) - y.mul_add(nh, -t) - y * nl
    };
    let (d1, d2) = (delta / a, -delta / b);
    if d1.abs() >= 0.5 || d2.abs() >= 0.5 {
        return None;
    }
    let m = -(a * log1pmx(d1) + b * log1pmx(d2));
    let h = (2.0 * m / nh).sqrt();
    if h >= ASYM_MAX_ETA {
        return None;
    }
    let (p, q) = (a / nh, b / nh);
    // u_n by the recurrence of u u' = s (pq + (q-p) u - u²), then d = 1 / (u(s) / (s u_1))
    let mut u = [0.0_f64; ASYM_TERMS + 3];
    u[1] = (p * q).sqrt();
    let v = |u: &[f64], k: usize| -> f64 { (1..k).map(|i| u[i] * u[k - i]).sum() };
    for n in 2..=ASYM_TERMS + 1 {
        let s: f64 = (2..n).map(|i| u[i] * u[n + 1 - i]).sum();
        let rhs = (q - p) * u[n - 1] - if n >= 3 { v(&u, n - 1) } else { 0.0 };
        u[n] = (2.0 / (n as f64 + 1.0) * rhs - s) / (2.0 * u[1]);
    }
    let mut d = [0.0_f64; ASYM_TERMS + 1];
    d[0] = 1.0;
    for n in 1..=ASYM_TERMS {
        d[n] = -(1..=n).map(|j| u[j + 1] / u[1] * d[n - j]).sum::<f64>();
    }
    // d_n s^n integrated over the lower side: odd powers change sign there
    let flip = if delta < 0.0 { -1.0 } else { 1.0 };
    let e = (-m).exp();
    let mut jm2 = (2.0 * PI / nh).sqrt() * 0.5 * erfc(h * (nh / 2.0).sqrt());
    let mut j1 = e / nh;
    let mut sum = 0.0;
    let mut hp = 1.0; // h^(n-1)
    let mut sign = flip;
    for n in 1..=ASYM_TERMS {
        let jn = if n == 1 {
            j1
        } else {
            hp *= h;
            let j = ((n as f64 - 1.0) * jm2 + hp * e) / nh;
            jm2 = j1;
            j1 = j;
            j
        };
        sum += sign * d[n] * jn;
        sign *= flip;
        if n == 1 {
            hp = 1.0;
        }
    }
    let _ = jm2;
    let tail = (stirling_corr(nh) - stirling_corr(a) - stirling_corr(b)).exp()
        * (0.5 * erfc(h * (nh / 2.0).sqrt()) + (nh / (2.0 * PI)).sqrt() * sum);
    Some(if delta >= 0.0 { (1.0 - tail, tail) } else { (tail, 1.0 - tail) })
}
/// Regularized incomplete beta `(I_x(a,b), 1 - I_x(a,b))`, `a, b > 0`, `0 <= x <= 1`.
pub fn beta_inc(x: f64, a: f64, b: f64) -> R<(f64, f64)> {
    beta_inc_xy(x, 1.0 - x, a, b)
}

/// As [`beta_inc`] with `y = 1-x` given exactly by the caller.
pub fn beta_inc_xy(x: f64, y: f64, a: f64, b: f64) -> R<(f64, f64)> {
    if a.is_nan() || b.is_nan() || x.is_nan() || y.is_nan() || a <= 0.0 || b <= 0.0 || x < 0.0 || y < 0.0 {
        return Err(SpecialError::Domain);
    }
    if x == 0.0 {
        return Ok((0.0, 1.0));
    }
    if y == 0.0 {
        return Ok((1.0, 0.0));
    }
    if a >= ASYM_MIN
        && b >= ASYM_MIN
        && let Some(t) = beta_asym(x, y, a, b)
    {
        return Ok(t);
    }
    if x < (a + 1.0) / (a + b + 2.0) {
        let i = beta_pref(a, b, x, y) * beta_fraction(a, b, x, y)? / a;
        // a tiny `a` makes `i` nearly 1: its complement is taken from the small-shape form, not `1 - i`
        let c = if a < SMALL_A && i > 0.5 { beta_small_complement(x, b, a) } else { 1.0 - i };
        Ok((i, c))
    } else {
        let q = beta_pref(a, b, x, y) * beta_fraction(b, a, y, x)? / b;
        let c = if b < SMALL_A && q > 0.5 { beta_small_complement(y, a, b) } else { 1.0 - q };
        Ok((c, q))
    }
}

/// The `x` in `[lo, hi]`, `0 < lo`, where the strictly monotone `f` crosses `target`: geometric bisection down to a
/// factor of two, then bisection on `x` itself until no double lies between the ends, so the root is as precise as `f`
/// is. A root below `lo` is reported as 0; one above `hi` is an error; a root exactly at an end is that end. A
/// non-finite `f` value is an error, never a side of the crossing. Every `f` failure is passed on.
pub fn solve_monotone(
    f: impl Fn(f64) -> R<f64>,
    lo: f64,
    hi: f64,
    decreasing: bool,
    target: f64,
) -> R<f64> {
    // `Some(true)` when the root lies above `x`, `None` when `f(x)` is exactly the target
    let above = |x: f64| -> R<Option<bool>> {
        let v = f(x)?;
        if !v.is_finite() {
            return Err(SpecialError::NoConvergence);
        }
        Ok(if v == target { None } else { Some(if decreasing { v > target } else { v < target }) })
    };
    match above(lo)? {
        None => return Ok(lo),
        Some(false) => return Ok(0.0),
        Some(true) => {}
    }
    match above(hi)? {
        None => return Ok(hi),
        Some(true) => return Err(SpecialError::NoConvergence),
        Some(false) => {}
    }
    let (mut lo, mut hi) = (lo, hi);
    while hi > 2.0 * lo {
        let mid = lo.sqrt() * hi.sqrt();
        match above(mid)? {
            None => return Ok(mid),
            Some(true) => lo = mid,
            Some(false) => hi = mid,
        }
    }
    loop {
        // no overflow: both ends are finite and positive
        let mid = lo + 0.5 * (hi - lo);
        if mid <= lo || mid >= hi {
            return Ok(hi);
        }
        match above(mid)? {
            None => return Ok(mid),
            Some(true) => lo = mid,
            Some(false) => hi = mid,
        }
    }
}
#[cfg(test)]
#[allow(clippy::excessive_precision)] // reference values are printed with 17 digits
mod tests {
    use super::*;

    #[test]
    fn solve_monotone_inverts_a_far_tail() {
        // Q(2, x) = 1e-300 on the tail, and a lower-tail root of P(0.5, x) = 0.3.
        let x = solve_monotone(|x| gamma_inc(2.0, x).map(|t| t.1), f64::MIN_POSITIVE, 1e308, true, 1e-300).unwrap();
        close(gamma_inc(2.0, x).unwrap().1, 1e-300, 1e-12);
        let x = solve_monotone(|x| gamma_inc(0.5, x).map(|t| t.0), f64::MIN_POSITIVE, 1e308, false, 0.3).unwrap();
        close(gamma_inc(0.5, x).unwrap().0, 0.3, 1e-14);
        assert_eq!(solve_monotone(Ok, 1.0, 2.0, false, 0.5), Ok(0.0));
        assert_eq!(solve_monotone(Ok, 1.0, 2.0, false, 1.0), Ok(1.0));
        assert_eq!(solve_monotone(|x| Ok(x * 0.0 / 0.0), 1.0, 2.0, false, 1.5), Err(SpecialError::NoConvergence));
        assert_eq!(solve_monotone(Ok, 1.0, 2.0, false, 5.0), Err(SpecialError::NoConvergence));
    }

    fn close(got: f64, want: f64, tol: f64) {
        assert!(
            (got - want).abs() <= tol * want.abs(),
            "got {got:e}, want {want:e}, rel {:e}",
            ((got - want) / want).abs()
        );
    }

    #[test]
    fn beta_small_shapes_keep_both_tails() {
        // (x, a, b, I, 1 - I): mpmath.betainc(a, b, 0, x, regularized=True) at 150 digits, rounded to f64.
        for &(x, a, b, i, c) in &[
            (0.9, 1.0, 1e-20, 2.3025850929940459e-20, 1.0),
            (0.9, 2.5, 1e-300, 1.170316343532798e-300, 1.0),
            (0.99, 5.0, 1e-5, 2.5615121036032401e-5, 1.0 - 2.5615121036032401e-5),
            (0.3, 1e-10, 40.0, 0.99999999999999999, 5.0327374712935501e-18),
            (0.7, 1e-3, 1e-3, 0.50042303786032353, 0.49957696213967647),
            (0.3, 1e-7, 2.0, 0.99999994960271839, 5.0397281612650448e-8),
            (0.9, 1e-20, 1.0, 1.0, 1.0536051565782628e-21),
            (0.2, 1e-4, 0.5, 0.99971132992583412, 0.00028867007416588427),
        ] {
            let (got_i, got_c) = beta_inc(x, a, b).unwrap();
            close(got_i, i, 1e-13);
            close(got_c, c, 1e-13);
        }
    }
    #[test]
    fn gamma_inc_uniform_transition_region_matches_the_expansion_at_high_precision() {
        // x = a + c·√a. mpmath.gammainc agrees with the high-precision Temme sum to 1e-17 for a <= 1e6 (checked when the
        // table was made); beyond that mpmath is too slow and the expansion (truncation ~ a^-7) is the reference.
        for &(a, c, p, q) in &[
        (1000.0, -4.0, 1.5119841720547503e-5, 0.99998488015827945),
        (1000.0, -1.0, 0.15861399679200126, 0.84138600320799874),
        (1000.0, 0.0, 0.50420524418021551, 0.49579475581978449),
        (1000.0, 0.5, 0.69424393281844778, 0.30575606718155222),
        (1000.0, 3.0, 0.99825275449853486, 0.0017472455014651355),
        (30000.0, -4.0, 2.7973334102856539e-5, 0.99997202666589714),
        (30000.0, -1.0, 0.15865390410681367, 0.84134609589318633),
        (30000.0, 0.0, 0.50076776491877105, 0.49923223508122895),
        (30000.0, 0.5, 0.69197056257812983, 0.30802943742187017),
        (30000.0, 3.0, 0.99858106114880409, 0.0014189388511959125),
        (1000000.0, -4.0, 3.1007118211082967e-5, 0.99996899288178892),
        (1000000.0, -1.0, 0.15865521357430365, 0.84134478642569635),
        (1000000.0, 0.0, 0.50013298076087259, 0.49986701923912741),
        (1000000.0, 0.5, 0.69155047577149718, 0.30844952422850282),
        (1000000.0, 3.0, 0.99863825935378241, 0.0013617406462175915),
        (1000000000.0, -4.0, 3.1650086457170994e-5, 0.99996834991354283),
        (1000000000.0, -1.0, 0.15865525389121661, 0.84134474610878339),
        (1000000000.0, 0.0, 0.50000420522087006, 0.49999579477912994),
        (1000000000.0, 0.5, 0.69146524459357268, 0.30853475540642732),
        (1000000000.0, 3.0, 0.99864972821771788, 0.0013502717822821228),
        (1000000000000.0, -4.0, 3.1670572687032022e-5, 0.99996832942731297),
        (1000000000000.0, -1.0, 0.15865525393141672, 0.84134474606858328),
        (1000000000000.0, 0.0, 0.50000013298076013, 0.49999986701923987),
        (1000000000000.0, 0.5, 0.69146254929034296, 0.30853745070965704),
        (1000000000000.0, 3.0, 0.9986500901500831, 0.0013499098499169015),
        (1000000000000000.0, -4.0, 3.1671220807014127e-5, 0.99996832877919299),
        (1000000000000000.0, -1.0, 0.15865525375304638, 0.84134474624695362),
        (1000000000000000.0, 0.0, 0.50000000420522087, 0.49999999579477913),
        (1000000000000000.0, 0.5, 0.69146246349129667, 0.30853753650870333),
        (1000000000000000.0, 3.0, 0.9986501015869283, 0.0013498984130716982),
        ] {
            let x = a + c * f64::sqrt(a);
            let (gp, gq) = gamma_inc(a, x).unwrap();
            close(gp, p, 1e-13);
            close(gq, q, 1e-13);
        }
    }

    #[test]
    fn erfc_keeps_relative_precision_in_the_tail() {
        // mpmath.erfc at 50 digits
        for &(x, want) in &[
            (0.1, 0.8875370839817151),
            (1.0, 0.15729920705028513),
            (1.9, 0.0072095707647425328),
            (2.0, 0.0046777349810472658),
            (5.0, 1.5374597944280349e-12),
            (10.0, 2.0884875837625448e-45),
            (26.0, 5.6631924088561428e-296),
        ] {
            close(erfc(x), want, 5e-15);
        }
        close(erf(0.3), 0.32862675945912742, 1e-15);
    }
    #[test]
    fn beta_large_shapes_match_the_expansion_at_high_precision() {
        // (x, a, b, I, 1 - I) with x = mean + c·sd; reference: the same expansion at 80 digits and 30 terms, which agrees
        // with mpmath.betainc to better than 1e-17 for a, b up to 3e3 (checked) and whose truncation falls with N.
        for &(x, a, b, i, c) in &[
        (0.35893087682828034, 100.0, 100.0, 2.3708481910596957e-5, 0.9999762915180894),
        (0.4294654384141402, 100.0, 100.0, 0.022612695608160762, 0.97738730439183924),
        (0.482366359603535, 100.0, 100.0, 0.30914099825847767, 0.69085900174152233),
        (0.5, 100.0, 100.0, 0.5, 0.5),
        (0.517633640396465, 100.0, 100.0, 0.69085900174152233, 0.30914099825847767),
        ] {
            let (gi, gc) = beta_inc(x, a, b).unwrap();
            close(gi, i, 1e-13);
            close(gc, c, 1e-13);
        }
    }
    #[test]
    fn ln_gamma_matches_mpmath() {
        // Each value: mpmath.loggamma(mpf(x)) at 40 digits, rounded to f64.
        for &(x, want) in &[
            (0.5, 0.5723649429247001),
            (1e-5, 11.512919692895826),
            (1.5, -0.12078223763524522),
            (3.7, 1.4280723266653879),
            (9.99, 12.779315214350193),
            (10.0, 12.801827480081469),
            (20.5, 40.8315009745308),
            (100.25, 360.28455963776423),
            (123456.789, 1323902.018795063),
        ] {
            close(ln_gamma(x), want, 2e-14);
        }
    }

    #[test]
    fn gamma_inc_matches_mpmath() {
        // Rows (a, x, P, Q); P = mpmath.gammainc(a, 0, x, regularized=True), Q = mpmath.gammainc(a, x, mpmath.inf,
        // regularized=True), both at 40 digits, rounded to f64.
        let cases: &[(f64, f64, f64, f64)] = &[
            (0.5, 0.2, 0.4729107431344619, 0.5270892568655381),
            (0.5, 30.0, 0.9999999999999906, 9.485737571073848e-15),
            (3.0, 0.1, 0.00015465307026467164, 0.9998453469297354),
            (3.0, 50.0, 1.0, 2.509303552201057e-19),
            (10.0, 10.0, 0.5420702855281478, 0.4579297144718522),
            (10.0, 300.0, 1.0, 2.878499265537018e-114),
            (100.0, 80.0, 0.017108313035133115, 0.9828916869648668),
            (100.0, 150.0, 0.9999940754596646, 5.924540335483916e-06),
            (10000.0, 9900.0, 0.15865119219356466, 0.8413488078064354),
            (10000.0, 10200.0, 0.9767126778664011, 0.023287322133598805),
            (1000000.0, 1000000.0, 0.5001329807608725, 0.4998670192391274),
            (0.001, 0.5, 0.9994399333435292, 0.0005600666564707498),
            (0.01, 1.5, 0.9989864569775047, 0.0010135430224953092),
            (2.5, 1e-05, 9.515260653112764e-14, 0.9999999999999049),
            (50.0, 700.0, 1.0, 4.477429603599747e-228),
        ];
        for &(a, x, p, q) in cases {
            let (gp, gq) = gamma_inc(a, x).unwrap();
            close(gp, p, 1e-13);
            close(gq, q, 1e-13);
        }
    }

    #[test]
    fn beta_inc_matches_mpmath() {
        // Rows (x, a, b, I, 1-I); I = mpmath.betainc(a, b, 0, x, regularized=True), 1-I =
        // mpmath.betainc(a, b, x, 1, regularized=True), both at 40 digits, rounded to f64.
        let cases: &[(f64, f64, f64, f64, f64)] = &[
            (0.3, 0.5, 0.5, 0.36901011956554536, 0.6309898804344546),
            (0.4, 2.0, 3.0, 0.5248, 0.4752),
            (0.9, 2.0, 3.0, 0.9963, 0.0037),
            (1e-05, 1.0, 100000.0, 0.6321223982334278, 0.36787760176657225),
            (0.001, 1.0, 100000.0, 1.0, 3.538527688343442e-44),
            (0.05, 5.0, 200.0, 0.9768755260425253, 0.023124473957474766),
            (0.2, 5.0, 200.0, 0.999999999999995, 5.044494705420838e-15),
            (0.4, 30.0, 40.0, 0.31814380259056285, 0.6818561974094371),
            (0.5, 1000.0, 1000.0, 0.5, 0.5),
            (0.47, 1000.0, 1000.0, 0.0036225247314441503, 0.9963774752685558),
            (0.0909, 2000.0, 20000.0, 0.5006804621763142, 0.4993195378236858),
            (0.3, 0.01, 0.02, 0.6611784272511073, 0.3388215727488927),
            (1e-05, 0.5, 100000.0, 0.8427013118385188, 0.15729868816148118),
            (0.99, 100.0, 3.0, 0.9169110148894399, 0.08308898511056009),
            (0.5, 3.0, 0.001, 6.821516304182144e-05, 0.9999317848369582),
        ];
        for &(x, a, b, i, c) in cases {
            let (gi, gc) = beta_inc(x, a, b).unwrap();
            close(gi, i, 1e-13);
            close(gc, c, 1e-13);
        }
    }

    #[test]
    fn domain_and_limits() {
        assert_eq!(gamma_inc(0.0, 1.0), Err(SpecialError::Domain));
        assert_eq!(gamma_inc(2.0, 0.0), Ok((0.0, 1.0)));
        assert_eq!(beta_inc(1.5, 1.0, 1.0), Err(SpecialError::Domain));
        assert_eq!(beta_inc(1.0, 2.0, 3.0), Ok((1.0, 0.0)));
    }
}
