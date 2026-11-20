//! Ball arithmetic: a dyadic midpoint and a radius bound; every operation returns a ball containing every result of
//! the operation on points of its argument balls (rounding of the midpoint goes into the radius). The working
//! precision is the thread's current `prec()` (bits of the midpoint), set by `with_prec`. Elementary functions are
//! evaluated by series with their truncation remainders bounded explicitly and added to the radius.

use super::num::{Fl, Mag};
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;

thread_local! {
    static PREC: Cell<u64> = const { Cell::new(128) };
    static CONSTS: RefCell<Vec<(u64, B, B)>> = const { RefCell::new(Vec::new()) };
}

pub fn prec() -> u64 {
    PREC.with(Cell::get)
}

/// Run `f` at `p` bits of working precision.
pub fn with_prec<T>(p: u64, f: impl FnOnce() -> T) -> T {
    let old = PREC.with(|c| c.replace(p));
    let out = f();
    PREC.with(|c| c.set(old));
    out
}

#[derive(Clone, Debug)]
pub struct B {
    pub mid: Fl,
    pub rad: Mag,
}

impl B {
    pub fn exact(mid: Fl) -> B {
        B { mid, rad: Mag::ZERO }
    }

    pub fn f(x: f64) -> B {
        B::exact(Fl::from_f64(x))
    }

    pub fn int(v: i64) -> B {
        B::exact(Fl::from_i64(v))
    }

    pub fn zero() -> B {
        B::exact(Fl::zero())
    }

    pub fn one() -> B {
        B::int(1)
    }

    /// Every real number.
    pub fn whole() -> B {
        B { mid: Fl::zero(), rad: Mag::INF }
    }

    pub fn is_finite(&self) -> bool {
        !self.rad.is_inf()
    }

    /// The midpoint rounded to the working precision, its rounding added to `rad`.
    fn rounded(mid: Fl, rad: Mag) -> B {
        let p = prec();
        let (m, lost) = mid.round(p);
        let rad = if lost { rad.add(Mag::ulp(&mid, p)) } else { rad };
        B { mid: m, rad }
    }

    pub fn add(&self, o: &B) -> B {
        if !self.is_finite() || !o.is_finite() {
            return B::whole();
        }
        let p = prec() as i64;
        // a term below the other's precision only widens the radius (no mantissa thousands of bits long)
        if !self.mid.is_zero() && !o.mid.is_zero() {
            if self.mid.top() - o.mid.top() > p + 8 {
                return B { mid: self.mid.clone(), rad: self.rad.add(o.rad).add(Mag::of(&o.mid)) }.round_now();
            }
            if o.mid.top() - self.mid.top() > p + 8 {
                return B { mid: o.mid.clone(), rad: self.rad.add(o.rad).add(Mag::of(&self.mid)) }.round_now();
            }
        }
        B::rounded(self.mid.add(&o.mid), self.rad.add(o.rad))
    }

    fn round_now(self) -> B {
        B::rounded(self.mid, self.rad)
    }

    pub fn sub(&self, o: &B) -> B {
        self.add(&o.neg())
    }

    pub fn neg(&self) -> B {
        B { mid: self.mid.neg(), rad: self.rad }
    }

    pub fn mul(&self, o: &B) -> B {
        if !self.is_finite() || !o.is_finite() {
            return B::whole();
        }
        let rad = Mag::of(&self.mid).mul(o.rad).add(Mag::of(&o.mid).mul(self.rad)).add(self.rad.mul(o.rad));
        B::rounded(self.mid.mul(&o.mid), rad)
    }

    pub fn sqr(&self) -> B {
        self.mul(self)
    }

    pub fn mul_2exp(&self, k: i64) -> B {
        B { mid: self.mid.mul_2exp(k), rad: self.rad.mul_2exp(k) }
    }

    pub fn mul_int(&self, v: i64) -> B {
        self.mul(&B::int(v))
    }

    /// The radius as an exact number, widened to at least 2^-(prec+64) of the midpoint so that the ends are never
    /// formed by an exact sum of numbers whose exponents are astronomically far apart (a looser bound is still one).
    fn rad_fl(&self) -> Fl {
        if !self.mid.is_zero() {
            let floor = self.mid.top() - prec() as i64 - 64;
            if self.rad.top() < floor {
                return Fl::pow2(floor);
            }
        }
        self.rad.to_fl()
    }

    /// A radius more than 2^(prec+64) times the midpoint: the ends are `±(|mid| + rad)` (the midpoint absorbed
    /// into the bound) rather than an exact sum of numbers whose exponents are astronomically far apart.
    fn rad_dominates(&self) -> bool {
        !self.mid.is_zero() && self.rad.top() > self.mid.top().saturating_add(prec() as i64 + 64)
    }

    /// The lower and upper ends (finite balls only).
    pub fn lo(&self) -> Fl {
        if self.rad_dominates() {
            return Mag::of(&self.mid).add(self.rad).to_fl().neg();
        }
        self.mid.sub(&self.rad_fl())
    }

    pub fn hi(&self) -> Fl {
        if self.rad_dominates() {
            return Mag::of(&self.mid).add(self.rad).to_fl();
        }
        self.mid.add(&self.rad_fl())
    }

    /// Certainly positive / negative / not zero.
    pub fn is_pos(&self) -> bool {
        if !self.is_finite() || self.mid.is_neg() || self.mid.is_zero() {
            return false;
        }
        // mid >= 2^top(mid) > rad when top(rad) < top(mid); otherwise compare exactly
        self.rad.top() < self.mid.top() || self.lo().cmp(&Fl::zero()) == Ordering::Greater
    }

    pub fn is_neg(&self) -> bool {
        self.neg().is_pos()
    }

    pub fn is_exact_zero(&self) -> bool {
        self.mid.is_zero() && self.rad.is_zero()
    }

    /// An upper bound on |x| over the ball.
    pub fn abs_hi(&self) -> Mag {
        Mag::of(&self.mid).add(self.rad)
    }

    /// A lower bound on |x| over the ball (zero when the ball contains zero).
    pub fn abs_lo(&self) -> Fl {
        // rad >= 2^top(rad) > |mid| when top(rad) > top(mid): the ball reaches zero
        if !self.is_finite() || self.rad.top() > self.mid.top() {
            return Fl::zero();
        }
        let l = self.mid.abs().sub(&self.rad_fl());
        if l.is_neg() { Fl::zero() } else { l }
    }

    /// Whether the radius is at most `2^-bits` of the smallest magnitude in the ball.
    pub fn rel_ok(&self, bits: i64) -> bool {
        if !self.is_finite() {
            return false;
        }
        if self.rad.is_zero() {
            return true;
        }
        let lo = self.abs_lo();
        !lo.is_zero() && self.rad.top() + bits < lo.top()
    }

    /// The smallest ball containing both.
    pub fn union(&self, o: &B) -> B {
        if !self.is_finite() || !o.is_finite() {
            return B::whole();
        }
        let lo = if self.lo().cmp(&o.lo()) == Ordering::Less { self.lo() } else { o.lo() };
        let hi = if self.hi().cmp(&o.hi()) == Ordering::Greater { self.hi() } else { o.hi() };
        B::from_ends(&lo, &hi)
    }

    /// The ball of the interval `[lo, hi]`.
    pub fn from_ends(lo: &Fl, hi: &Fl) -> B {
        // through ball sums (rounded, so ends of far-apart exponents cost no long mantissa): the centre is within
        // s.rad/2 of mid and the half width is at most |d|/2
        let (l, h) = (B::exact(lo.clone()), B::exact(hi.clone()));
        let s = l.add(&h);
        let d = h.sub(&l);
        B { mid: s.mid.mul_2exp(-1), rad: s.rad.add(d.abs_hi()).mul_2exp(-1) }
    }

    /// `1/x` from a Newton reciprocal of the midpoint and the exact residual `e = 1 - mid*y`:
    /// `1/mid = y/(1-e)`, so `|1/mid - y| <= |y| |e|/(1-|e|)`; the input radius adds `rad/lo^2`.
    pub fn recip(&self) -> B {
        if !self.is_finite() || self.abs_lo().is_zero() {
            return B::whole();
        }
        let p = prec();
        let (f, k) = self.mid.approx();
        let mut y = Fl::from_f64(1.0 / f).mul_2exp(-k);
        let mut good = 50u64;
        while good < p + 8 {
            // y <- y + y (1 - mid y), at twice the bits of the current approximation
            let bits = (2 * good + 16).min(p + 24);
            let (m, _) = self.mid.round(bits + 8);
            let e = Fl::from_i64(1).sub(&m.mul(&y));
            let (e, _) = e.round(bits + 8);
            y = y.add(&y.mul(&e)).round(bits).0;
            good *= 2;
        }
        let e = Fl::from_i64(1).sub(&self.mid.mul(&y));
        let ea = Mag::of(&e);
        // |e| < 1/2 holds by construction; the bound |y||e|/(1-|e|) <= 2|y||e|
        let err = Mag::of(&y).mul(ea).mul_2exp(1);
        let lo = self.abs_lo();
        let inr = if self.rad.is_zero() {
            Mag::ZERO
        } else {
            // rad / lo^2, with lo rounded down to 40 bits and the quotient bounded through an upper reciprocal
            let (l, _) = lo.round(40);
            let l2 = l.mul(&l);
            let (lf, lk) = l2.approx();
            Mag::from_f64_up(1.0 / lf * (1.0 + 1e-9)).mul_2exp(-lk).mul(self.rad)
        };
        B::rounded(y, err.add(inr))
    }

    pub fn div(&self, o: &B) -> B {
        self.mul(&o.recip())
    }

    pub fn div_int(&self, v: i64) -> B {
        if v == 0 || !self.is_finite() {
            return B::whole();
        }
        // long division of the midpoint by the integer; the radius scales by 1/|v| (bounded above)
        let p = prec();
        let (q, err) = self.mid.div_u64(v.unsigned_abs(), p);
        let q = if v < 0 { q.neg() } else { q };
        let rad = if self.rad.is_zero() { Mag::ZERO } else { self.rad.mul(Mag::from_f64_up(1.0 / v.unsigned_abs() as f64 * (1.0 + 1e-12))) };
        B::rounded(q, rad.add(err))
    }

    /// The nearest double of the midpoint (the caller checks the radius).
    pub fn to_f64(&self) -> f64 {
        self.mid.to_f64()
    }

    pub fn cmp_zero(&self) -> Option<Ordering> {
        if self.is_exact_zero() {
            Some(Ordering::Equal)
        } else if self.is_pos() {
            Some(Ordering::Greater)
        } else if self.is_neg() {
            Some(Ordering::Less)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------- constants
fn atanh_inv(q: i64) -> B {
    // atanh(1/q) = sum 1/((2k+1) q^(2k+1)); the tail after term n is below term_n/(q^2 - 1)
    let p = prec();
    let inv = B::one().div_int(q);
    let inv2 = inv.sqr();
    let mut pw = inv.clone();
    let mut s = B::zero();
    let mut k = 0i64;
    loop {
        let t = pw.div_int(2 * k + 1);
        s = s.add(&t);
        pw = pw.mul(&inv2);
        k += 1;
        if pw.abs_hi().top() < -(p as i64) - 8 {
            break;
        }
    }
    B { mid: s.mid, rad: s.rad.add(pw.abs_hi()) }
}

fn atan_inv(q: i64) -> B {
    // alternating, decreasing: the error is below the first omitted term
    let p = prec();
    let inv = B::one().div_int(q);
    let inv2 = inv.sqr();
    let mut pw = inv.clone();
    let mut s = B::zero();
    let mut k = 0i64;
    loop {
        let t = pw.div_int(2 * k + 1);
        s = if k % 2 == 0 { s.add(&t) } else { s.sub(&t) };
        pw = pw.mul(&inv2);
        k += 1;
        if pw.abs_hi().top() < -(p as i64) - 8 {
            break;
        }
    }
    B { mid: s.mid, rad: s.rad.add(pw.abs_hi()) }
}

/// (ln 2, pi) at the working precision plus a margin, cached per precision.
fn consts() -> (B, B) {
    let p = prec();
    if let Some(c) = CONSTS.with(|c| c.borrow().iter().find(|e| e.0 >= p + 64).map(|e| (e.1.clone(), e.2.clone()))) {
        return c;
    }
    let (ln2, pi) = with_prec(p + 96, || {
        let ln2 = atanh_inv(3).mul_2exp(1);
        let pi = atan_inv(5).mul_int(16).sub(&atan_inv(239).mul_int(4));
        (ln2, pi)
    });
    CONSTS.with(|c| c.borrow_mut().push((p + 96, ln2.clone(), pi.clone())));
    (ln2, pi)
}

pub fn ln2() -> B {
    consts().0
}

pub fn pi() -> B {
    consts().1
}

// ---------------------------------------------------------------- exp, log
/// `sum_{j>=start} x^j/j!` for |x| <= 1/2, with the tail bound `2 |x|^N / N!`.
fn exp_series(x: &B, start: i64) -> B {
    let p = prec() as i64;
    let mut s = B::zero();
    let mut term = B::one();
    for j in 1..start {
        term = term.mul(x).div_int(j);
    }
    let mut j = start;
    loop {
        if j > 0 {
            term = term.mul(x).div_int(j);
        }
        s = s.add(&term);
        if term.abs_hi().top() < s.mid.top().max(-(1 << 40)) - p - 8 || term.abs_hi().is_zero() {
            // the next term is at most |x|/(j+1) <= 1/2 of this one: the tail is below this term
            let tail = term.abs_hi();
            return B { mid: s.mid, rad: s.rad.add(tail) };
        }
        j += 1;
    }
}

pub fn exp(x: &B) -> B {
    if !x.is_finite() {
        return B::whole();
    }
    let p = prec();
    if x.mid.top() > 56 {
        // from |x| = 2^55 on, the reduced exponent x / ln 2 comes too near the exponent range of the balls
        // (exp(-2^61) was the whole line: the lower flank of GAMMA.DIST(5E-21,1E-20,1,TRUE), of slope 1e-20, reaches
        // that far)
        if x.mid.is_neg() && x.hi().is_neg() && x.hi().top() > 56 {
            // below exp(-2^55) < 2^-(2^55): a ball around zero of that size (never exported as a value; see
            // log-domain users)
            return B { mid: Fl::zero(), rad: Mag::pow2(-(1i64 << 55)) };
        }
        return B::whole();
    }
    if x.abs_hi().top() < -(p as i64) - 8 {
        // |x| < 2^-(p+8): e^x = 1 + x + theta x^2 (|theta| <= 1) is within 2|x| of 1 (no exact 1 + x)
        return B { mid: Fl::from_i64(1), rad: x.abs_hi().mul_2exp(1) };
    }
    if x.rad.top() > -8 {
        // a wide ball: exp is increasing, so the hull of the two ends
        return exp(&B::exact(x.lo())).union(&exp(&B::exact(x.hi())));
    }
    let (ln2, n) = with_prec(p + 80, || {
        let ln2 = ln2();
        let q = x.div(&ln2);
        (ln2, q.mid.add(&Fl::pow2(-1)).floor())
    });
    let r = with_prec(p + 80, || x.sub(&ln2.mul(&B::exact(n.clone()))));
    // r in about [-0.35, 0.35]; halve k times, sum, square back
    let k = ((p as f64).sqrt() / 2.0) as i64 + 1;
    let w = p + k as u64 + 24;
    let v = with_prec(w, || {
        let rk = r.mul_2exp(-k);
        let mut e = exp_series(&rk, 0);
        for _ in 0..k {
            e = e.sqr();
        }
        e
    });
    let n = n.to_i128().expect("exponent within 2^60") as i64;
    let out = v.mul_2exp(n);
    B::rounded(out.mid, out.rad)
}

pub fn expm1(x: &B) -> B {
    if !x.is_finite() {
        return B::whole();
    }
    let small = x.abs_hi().top() < -2;
    if !small {
        return exp(x).sub(&B::one());
    }
    // |x| < 1/4: the series from the first power keeps relative accuracy
    with_prec(prec() + 16, || exp_series(x, 1))
}

/// `expm1(x) - x` with relative accuracy near zero (the series from x^2/2).
pub fn expm1mx(x: &B) -> B {
    if !x.is_finite() {
        return B::whole();
    }
    if x.abs_hi().top() < -2 {
        return with_prec(prec() + 16, || exp_series(x, 2));
    }
    expm1(x).sub(x)
}

/// `log1p(y) - y` with relative accuracy near zero: `sum_{j>=2} (-1)^(j+1) y^j / j`, tail below
/// `|y|^n / (n (1 - |y|)) <= 2 |y|^n` for |y| < 1/4.
pub fn log1pmx(y: &B) -> B {
    if !y.is_finite() {
        return B::whole();
    }
    if y.abs_hi().top() >= -2 {
        return log1p(y).sub(y);
    }
    with_prec(prec() + 16, || {
        let p = prec() as i64;
        let mut pw = y.sqr();
        let mut s = B::zero();
        let mut j = 2i64;
        loop {
            let t = pw.div_int(j);
            s = if j % 2 == 0 { s.sub(&t) } else { s.add(&t) };
            pw = pw.mul(y);
            j += 1;
            if pw.is_exact_zero() || pw.abs_hi().top() < s.mid.top().max(-(1 << 40)) - p - 8 {
                return B { mid: s.mid, rad: s.rad.add(pw.abs_hi().mul_2exp(1)) };
            }
        }
    })
}

/// ln of a ball whose points are all positive.
pub fn ln(x: &B) -> B {
    if !x.is_finite() || !x.is_pos() {
        return B::whole();
    }
    if !x.rad.is_zero() && x.rad.top() > x.mid.top() - 8 {
        // a wide ball: the hull of the logarithms of its ends
        return ln(&B::exact(x.lo())).union(&ln(&B::exact(x.hi())));
    }
    let p = prec();
    let m = x.mid.clone();
    let mut t = m.top();
    let mut y = m.mul_2exp(-t);
    // y in [1, 2): move to [0.70, 1.41]
    if y.cmp(&Fl::from_f64(std::f64::consts::SQRT_2)) == Ordering::Greater {
        y = y.mul_2exp(-1);
        t += 1;
    }
    let w = p + 24;
    let v = with_prec(w, || {
        let yb = B::exact(y.clone());
        let z = B::exact(y.sub(&Fl::from_i64(1))).div(&yb.add(&B::one()));
        let z2 = z.sqr();
        let mut pw = z.clone();
        let mut s = B::zero();
        let mut k = 0i64;
        loop {
            s = s.add(&pw.div_int(2 * k + 1));
            pw = pw.mul(&z2);
            k += 1;
            if pw.is_exact_zero() || pw.abs_hi().top() < s.mid.top().max(-(1 << 40)) - w as i64 - 8 {
                break;
            }
        }
        // tail sum_{j>=k} z^(2j+1)/(2j+1) <= |pw| / (1 - z^2) <= 2 |pw| (|z| < 0.18)
        let s = B { mid: s.mid, rad: s.rad.add(pw.abs_hi().mul_2exp(1)) }.mul_2exp(1);
        if t == 0 { s } else { s.add(&ln2().mul(&B::int(t))) }
    });
    // the input radius: |ln(a) - ln(b)| <= |a - b| / min(a, b)
    let lo = x.abs_lo();
    let inr = if x.rad.is_zero() { Mag::ZERO } else { x.rad.mul(recip_up(&lo)) };
    B::rounded(v.mid, v.rad.add(inr))
}

/// An upper bound on 1/v for v > 0.
pub fn recip_up(v: &Fl) -> Mag {
    let (f, k) = v.approx();
    Mag::from_f64_up(1.0 / f * (1.0 + 1e-12)).mul_2exp(-k)
}

/// ln(1 + x), relative accuracy kept for tiny x (1 + x is formed exactly).
pub fn log1p(x: &B) -> B {
    if !x.is_finite() {
        return B::whole();
    }
    let m = x.abs_hi();
    if m.top() < -(prec() as i64) - 64 {
        // |x| < 2^-(p+64): |log1p(x) - x| <= x^2, and the derivative is at most 2 over the ball (no exact 1 + x)
        return B { mid: x.mid.clone(), rad: x.rad.mul_2exp(1).add(m.mul(m)) };
    }
    let y = if x.mid.top() < -(prec() as i64) - 64 {
        B { mid: Fl::from_i64(1), rad: x.rad.add(Mag::of(&x.mid)) }
    } else {
        B { mid: x.mid.add(&Fl::from_i64(1)), rad: x.rad }
    };
    ln(&y)
}

pub fn sqrt(x: &B) -> B {
    if !x.is_finite() {
        return B::whole();
    }
    let p = prec();
    if !x.is_pos() {
        if x.hi().is_neg() {
            return B::whole();
        }
        // [0, sqrt(hi)]
        let h = x.hi();
        let s = h.sqrt_floor(32).add(&Fl::pow2(h.top() / 2 - 30));
        return B::from_ends(&Fl::zero(), &s);
    }
    let s = x.mid.sqrt_floor(p);
    // sqrt(mid) - s in [0, 2^(top - p + 2)]; input radius / (2 sqrt(lo))
    let err = Mag::pow2(s.top() - p as i64 + 2);
    let lo = x.abs_lo();
    let inr = if x.rad.is_zero() { Mag::ZERO } else { x.rad.mul(recip_up(&lo.sqrt_floor(32))).mul_2exp(-1) };
    B::rounded(s, err.add(inr))
}

/// sin and cos of a ball with |x| <= 1, Taylor series (alternating, terms decreasing: error below the next term).
pub fn sin_cos(x: &B) -> (B, B) {
    let p = prec() as i64;
    let x2 = x.sqr();
    let (mut s, mut c) = (B::zero(), B::zero());
    let mut ts = x.clone();
    let mut tc = B::one();
    let mut j = 0i64;
    loop {
        if j % 2 == 0 {
            s = s.add(&ts);
            c = c.add(&tc);
        } else {
            s = s.sub(&ts);
            c = c.sub(&tc);
        }
        tc = tc.mul(&x2).div_int((2 * j + 1) * (2 * j + 2));
        ts = ts.mul(&x2).div_int((2 * j + 2) * (2 * j + 3));
        j += 1;
        if tc.abs_hi().top() < -p - 8 && ts.abs_hi().top() < s.mid.top().max(-(1 << 40)) - p - 8 {
            break;
        }
    }
    (B { mid: s.mid, rad: s.rad.add(ts.abs_hi()) }, B { mid: c.mid, rad: c.rad.add(tc.abs_hi()) })
}

/// sin(pi f) for an exact f in [0, 1], through the nearest quarter so the series argument is at most pi/4.
pub fn sinpi(f: &Fl) -> B {
    let w = prec() + 16;
    with_prec(w, || {
        let half = Fl::pow2(-1);
        // sin(pi f) = sin(pi (1 - f)): reflect to [0, 1/2]
        let g = if f.cmp(&half) == Ordering::Greater { Fl::from_i64(1).sub(f) } else { f.clone() };
        if g.is_zero() {
            return B::zero();
        }
        let quarter = Fl::pow2(-2);
        if g.cmp(&quarter) == Ordering::Greater {
            // sin(pi g) = cos(pi (1/2 - g))
            let h = B::exact(half.sub(&g)).mul(&pi());
            sin_cos(&h).1
        } else {
            sin_cos(&B::exact(g).mul(&pi())).0
        }
    })
}

/// log(exp(a) + exp(b)) = max + log1p(exp(min - max)).
pub fn logaddexp(a: &B, b: &B) -> B {
    let (hi, lo) = if a.mid.cmp(&b.mid) == Ordering::Less { (b, a) } else { (a, b) };
    let d = lo.sub(hi);
    if d.mid.top() > 20 && d.mid.is_neg() && d.hi().is_neg() && d.hi().top() > 20 {
        // exp(d) < exp(-2^20): log1p(exp(d)) in [0, exp(d)]
        return B { mid: hi.mid.clone(), rad: hi.rad.add(Mag::pow2(-(1 << 20))) };
    }
    hi.add(&log1p(&exp(&d)))
}
