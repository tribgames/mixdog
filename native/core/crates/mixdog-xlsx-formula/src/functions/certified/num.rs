//! Exact dyadic numbers: a sign, an unsigned multi-limb integer mantissa and an unbounded (i64) binary exponent.
//! Addition, subtraction and multiplication are exact; `round` truncates to a requested number of bits and reports
//! whether anything was dropped, so the ball layer can account for it outwardly. `Mag` is an upper bound on a
//! nonnegative magnitude (a 32-bit mantissa rounded up, an i64 exponent, or infinity) used for ball radii.

use std::cmp::Ordering;

// ---------------------------------------------------------------- unsigned limbs (little endian, no high zeros)
fn trim(v: &mut Vec<u64>) {
    while v.last() == Some(&0) {
        v.pop();
    }
}

fn bitlen(a: &[u64]) -> u64 {
    match a.last() {
        None => 0,
        Some(&top) => (a.len() as u64 - 1) * 64 + (64 - u64::from(top.leading_zeros())),
    }
}

fn cmp_mag(a: &[u64], b: &[u64]) -> Ordering {
    if a.len() != b.len() {
        return a.len().cmp(&b.len());
    }
    for i in (0..a.len()).rev() {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    Ordering::Equal
}

fn add_mag(a: &[u64], b: &[u64]) -> Vec<u64> {
    let (a, b) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    let mut out = Vec::with_capacity(a.len() + 1);
    let mut carry = 0u64;
    for (i, &x) in a.iter().enumerate() {
        let (s1, c1) = x.overflowing_add(*b.get(i).unwrap_or(&0));
        let (s2, c2) = s1.overflowing_add(carry);
        out.push(s2);
        carry = u64::from(c1) + u64::from(c2);
    }
    if carry != 0 {
        out.push(carry);
    }
    out
}

/// `a - b` for `a >= b`.
fn sub_mag(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = Vec::with_capacity(a.len());
    let mut borrow = 0u64;
    for (i, &x) in a.iter().enumerate() {
        let (d1, b1) = x.overflowing_sub(*b.get(i).unwrap_or(&0));
        let (d2, b2) = d1.overflowing_sub(borrow);
        out.push(d2);
        borrow = u64::from(b1) + u64::from(b2);
    }
    debug_assert_eq!(borrow, 0);
    trim(&mut out);
    out
}

fn mul_mag(a: &[u64], b: &[u64]) -> Vec<u64> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0u64; a.len() + b.len()];
    for (i, &x) in a.iter().enumerate() {
        let mut carry = 0u128;
        for (j, &y) in b.iter().enumerate() {
            let t = u128::from(x) * u128::from(y) + u128::from(out[i + j]) + carry;
            out[i + j] = t as u64;
            carry = t >> 64;
        }
        let mut k = i + b.len();
        while carry != 0 {
            let t = u128::from(out[k]) + carry;
            out[k] = t as u64;
            carry = t >> 64;
            k += 1;
        }
    }
    trim(&mut out);
    out
}

fn shl_mag(a: &[u64], bits: u64) -> Vec<u64> {
    if a.is_empty() {
        return Vec::new();
    }
    let (limbs, rem) = ((bits / 64) as usize, (bits % 64) as u32);
    let mut out = vec![0u64; limbs];
    if rem == 0 {
        out.extend_from_slice(a);
    } else {
        let mut carry = 0u64;
        for &x in a {
            out.push((x << rem) | carry);
            carry = x >> (64 - rem);
        }
        if carry != 0 {
            out.push(carry);
        }
    }
    out
}

/// `a >> bits` and whether a nonzero bit was shifted out.
fn shr_mag(a: &[u64], bits: u64) -> (Vec<u64>, bool) {
    let (limbs, rem) = ((bits / 64) as usize, (bits % 64) as u32);
    if limbs >= a.len() {
        return (Vec::new(), !a.is_empty());
    }
    let mut lost = a[..limbs].iter().any(|&x| x != 0);
    let src = &a[limbs..];
    let mut out = Vec::with_capacity(src.len());
    if rem == 0 {
        out.extend_from_slice(src);
    } else {
        lost |= src[0] & ((1u64 << rem) - 1) != 0;
        for i in 0..src.len() {
            let hi = src.get(i + 1).map_or(0, |&n| n << (64 - rem));
            out.push((src[i] >> rem) | hi);
        }
    }
    trim(&mut out);
    (out, lost)
}

fn trailing_zeros(a: &[u64]) -> u64 {
    let mut n = 0;
    for &x in a {
        if x == 0 {
            n += 64;
        } else {
            return n + u64::from(x.trailing_zeros());
        }
    }
    n
}

/// floor(sqrt(a)) by Newton's iteration on integers.
fn isqrt_mag(a: &[u64]) -> Vec<u64> {
    if a.is_empty() {
        return Vec::new();
    }
    // start above the root: 2^ceil(bits/2)
    let mut x = shl_mag(&[1], bitlen(a).div_ceil(2));
    loop {
        // y = (x + a / x) / 2, with a / x formed by the exact long division below
        let q = div_mag(a, &x);
        let (y, _) = shr_mag(&add_mag(&x, &q), 1);
        if cmp_mag(&y, &x) != Ordering::Less {
            return x;
        }
        x = y;
    }
}

/// floor(a / b), b nonzero, by binary long division (used only by the integer square root, on short operands).
fn div_mag(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut q = Vec::new();
    let mut r: Vec<u64> = Vec::new();
    for bit in (0..bitlen(a)).rev() {
        r = shl_mag(&r, 1);
        if a[(bit / 64) as usize] >> (bit % 64) & 1 == 1 {
            if r.is_empty() {
                r.push(1);
            } else {
                r[0] |= 1;
            }
        }
        if cmp_mag(&r, b) != Ordering::Less {
            r = sub_mag(&r, b);
            let limb = (bit / 64) as usize;
            if q.len() <= limb {
                q.resize(limb + 1, 0);
            }
            q[limb] |= 1u64 << (bit % 64);
        }
    }
    trim(&mut q);
    q
}

// ---------------------------------------------------------------- exact dyadic numbers
/// `(-1)^neg * m * 2^e`, with `m` odd (canonical) or empty for zero.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fl {
    neg: bool,
    m: Vec<u64>,
    e: i64,
}

impl Fl {
    pub fn zero() -> Fl {
        Fl { neg: false, m: Vec::new(), e: 0 }
    }

    fn make(neg: bool, mut m: Vec<u64>, e: i64) -> Fl {
        trim(&mut m);
        if m.is_empty() {
            return Fl::zero();
        }
        let tz = trailing_zeros(&m);
        if tz == 0 {
            return Fl { neg, m, e };
        }
        let (m, _) = shr_mag(&m, tz);
        Fl { neg, m, e: e + tz as i64 }
    }

    pub fn from_u128(v: u128) -> Fl {
        Fl::make(false, vec![v as u64, (v >> 64) as u64], 0)
    }

    pub fn from_i64(v: i64) -> Fl {
        let mut f = Fl::from_u128(u128::from(v.unsigned_abs()));
        f.neg = v < 0 && !f.m.is_empty();
        f
    }

    /// The exact value of a finite double.
    pub fn from_f64(x: f64) -> Fl {
        assert!(x.is_finite(), "a finite double");
        if x == 0.0 {
            return Fl::zero();
        }
        let bits = x.to_bits();
        let exp = ((bits >> 52) & 0x7ff) as i64;
        let frac = bits & ((1u64 << 52) - 1);
        let (m, e) = if exp == 0 { (frac, -1074) } else { (frac | (1u64 << 52), exp - 1075) };
        Fl::make(x < 0.0, vec![m], e)
    }

    /// `2^k`.
    pub fn pow2(k: i64) -> Fl {
        Fl { neg: false, m: vec![1], e: k }
    }

    pub fn is_zero(&self) -> bool {
        self.m.is_empty()
    }

    pub fn is_neg(&self) -> bool {
        self.neg
    }

    /// The exponent of the leading bit (`|x|` in `[2^t, 2^(t+1))`); `i64::MIN` for zero.
    pub fn top(&self) -> i64 {
        if self.is_zero() { i64::MIN } else { self.e + bitlen(&self.m) as i64 - 1 }
    }

    /// The exponent of the lowest set bit (an integer is a value with `low() >= 0`).
    pub fn low(&self) -> i64 {
        if self.is_zero() { i64::MAX } else { self.e }
    }

    pub fn bits(&self) -> u64 {
        bitlen(&self.m)
    }

    pub fn neg(&self) -> Fl {
        Fl { neg: !self.neg && !self.is_zero(), m: self.m.clone(), e: self.e }
    }

    pub fn abs(&self) -> Fl {
        Fl { neg: false, m: self.m.clone(), e: self.e }
    }

    pub fn mul_2exp(&self, k: i64) -> Fl {
        if self.is_zero() { Fl::zero() } else { Fl { neg: self.neg, m: self.m.clone(), e: self.e + k } }
    }

    pub fn add(&self, o: &Fl) -> Fl {
        if self.is_zero() {
            return o.clone();
        }
        if o.is_zero() {
            return self.clone();
        }
        let e = self.e.min(o.e);
        let a = shl_mag(&self.m, (self.e - e) as u64);
        let b = shl_mag(&o.m, (o.e - e) as u64);
        if self.neg == o.neg {
            return Fl::make(self.neg, add_mag(&a, &b), e);
        }
        match cmp_mag(&a, &b) {
            Ordering::Equal => Fl::zero(),
            Ordering::Greater => Fl::make(self.neg, sub_mag(&a, &b), e),
            Ordering::Less => Fl::make(o.neg, sub_mag(&b, &a), e),
        }
    }

    pub fn sub(&self, o: &Fl) -> Fl {
        self.add(&o.neg())
    }

    pub fn mul(&self, o: &Fl) -> Fl {
        if self.is_zero() || o.is_zero() {
            return Fl::zero();
        }
        Fl::make(self.neg != o.neg, mul_mag(&self.m, &o.m), self.e + o.e)
    }

    /// Truncation toward zero to `p` significant bits; `true` when bits were dropped.
    pub fn round(&self, p: u64) -> (Fl, bool) {
        let n = self.bits();
        if n <= p {
            return (self.clone(), false);
        }
        let (m, lost) = shr_mag(&self.m, n - p);
        (Fl::make(self.neg, m, self.e + (n - p) as i64), lost)
    }

    /// `self / v` truncated toward zero with at least `p` significant bits, and a bound on the truncation (one unit
    /// of the quotient's last place, zero when exact): a single pass of long division by one limb, for the series
    /// of the elementary functions, which divide by small integers.
    pub fn div_u64(&self, v: u64, p: u64) -> (Fl, Mag) {
        if self.is_zero() {
            return (Fl::zero(), Mag::ZERO);
        }
        let s = p + 64;
        let a = shl_mag(&self.m, s);
        let mut q = vec![0u64; a.len()];
        let mut r: u128 = 0;
        for i in (0..a.len()).rev() {
            let cur = (r << 64) | u128::from(a[i]);
            q[i] = (cur / u128::from(v)) as u64;
            r = cur % u128::from(v);
        }
        let unit = self.e - s as i64;
        (Fl::make(self.neg, q, unit), if r != 0 { Mag::pow2(unit) } else { Mag::ZERO })
    }

    /// The integer part toward minus infinity, as an exact value.
    pub fn floor(&self) -> Fl {
        if self.is_zero() || self.e >= 0 {
            return self.clone();
        }
        let (m, lost) = shr_mag(&self.m, (-self.e) as u64);
        let f = Fl::make(self.neg, m, 0);
        if self.neg && lost { f.sub(&Fl::from_i64(1)) } else { f }
    }

    pub fn cmp(&self, o: &Fl) -> Ordering {
        // signs and leading exponents first: no exact difference of far-apart magnitudes
        let sgn = |x: &Fl| {
            if x.is_zero() {
                0
            } else if x.neg {
                -1
            } else {
                1
            }
        };
        let (a, b) = (sgn(self), sgn(o));
        if a != b {
            return a.cmp(&b);
        }
        if a == 0 {
            return Ordering::Equal;
        }
        if self.top() != o.top() {
            let mag = self.top().cmp(&o.top());
            return if a > 0 { mag } else { mag.reverse() };
        }
        let d = self.sub(o);
        if d.is_zero() {
            Ordering::Equal
        } else if d.neg {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }

    pub fn sqrt_floor(&self, p: u64) -> Fl {
        // sqrt(m 2^e): scale so the exponent is even and the mantissa has 2p bits, then the integer root
        assert!(!self.neg);
        if self.is_zero() {
            return Fl::zero();
        }
        let mut shift = (2 * p as i64 - self.bits() as i64).max(0) + 2;
        if (self.e - shift).rem_euclid(2) != 0 {
            shift += 1;
        }
        let m = shl_mag(&self.m, shift as u64);
        Fl::make(false, isqrt_mag(&m), (self.e - shift) / 2)
    }

    /// The nearest double (ties to even), with gradual underflow; `±inf` beyond the largest double.
    pub fn to_f64(&self) -> f64 {
        if self.is_zero() {
            return 0.0;
        }
        let sign = if self.neg { -1.0 } else { 1.0 };
        let t = self.top();
        if t > 1023 {
            return sign * f64::INFINITY;
        }
        // keep 53 bits for normal values, fewer below 2^-1022
        let keep = if t >= -1022 { 53 } else { 53 - (-1022 - t) };
        if keep <= 0 {
            // below half the least subnormal rounds to zero; exactly half rounds to zero (even), above to 2^-1074
            let half = Fl::pow2(-1075);
            return match self.abs().cmp(&half) {
                Ordering::Greater if keep == 0 => sign * f64::from_bits(1),
                _ => sign * 0.0,
            };
        }
        let n = self.bits() as i64;
        let (m, e) = if n <= keep {
            (self.m[0], self.e)
        } else {
            let (q, _) = shr_mag(&self.m, (n - keep) as u64);
            let mut q = q.first().copied().unwrap_or(0);
            // round half to even: the dropped part compared with half a unit
            let dropped = self.abs().sub(&Fl::make(false, vec![q], self.e + n - keep));
            let half = Fl::pow2(self.e + n - keep - 1);
            match dropped.cmp(&half) {
                Ordering::Greater => q += 1,
                Ordering::Equal if q & 1 == 1 => q += 1,
                _ => {}
            }
            (q, self.e + n - keep)
        };
        // m * 2^e, m <= 2^53, is representable (or overflows): scale in steps of 2^±1000, each exact
        let mut v = m as f64;
        let mut e = e;
        while e > 0 {
            let s = e.min(1000);
            v *= f64::powi(2.0, s as i32);
            e -= s;
        }
        while e < 0 {
            let s = (-e).min(1000);
            v *= f64::powi(2.0, -(s as i32));
            e += s;
        }
        sign * v
    }

    /// An approximation by a double of the mantissa and an exponent: `self ~= f * 2^k`, `f` in [1, 2).
    pub fn approx(&self) -> (f64, i64) {
        if self.is_zero() {
            return (0.0, 0);
        }
        let (r, _) = self.round(60);
        let n = r.bits() as i64;
        let mut f = 0.0;
        for (i, &limb) in r.m.iter().enumerate() {
            f += limb as f64 * f64::powi(2.0, (64 * i) as i32 - (n - 1) as i32);
        }
        (if r.neg { -f } else { f }, r.e + n - 1)
    }

    /// The value as an i128 when it is an integer that fits.
    pub fn to_i128(&self) -> Option<i128> {
        if self.is_zero() {
            return Some(0);
        }
        if self.e < 0 || self.top() > 125 {
            return None;
        }
        let m = shl_mag(&self.m, self.e as u64);
        let v = i128::from(m[0]) | (i128::from(*m.get(1).unwrap_or(&0)) << 64);
        Some(if self.neg { -v } else { v })
    }
}

// ---------------------------------------------------------------- magnitude upper bounds
/// An upper bound `m * 2^e` (m < 2^32), zero, or infinity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mag {
    m: u64,
    e: i64,
}

const MAG_BITS: u32 = 32;
const INF_E: i64 = i64::MAX;

impl Mag {
    pub const ZERO: Mag = Mag { m: 0, e: 0 };
    pub const INF: Mag = Mag { m: 1, e: INF_E };

    pub fn is_zero(self) -> bool {
        self.m == 0
    }

    pub fn is_inf(self) -> bool {
        self.e == INF_E
    }

    /// The bound of a (wide) mantissa `m` times `2^e`, rounded up to 32 bits.
    fn norm(m: u128, e: i64) -> Mag {
        if m == 0 {
            return Mag::ZERO;
        }
        let n = 128 - m.leading_zeros();
        if n <= MAG_BITS {
            return Mag { m: m as u64, e };
        }
        let s = n - MAG_BITS;
        let q = (m >> s) + u128::from(m & ((1u128 << s) - 1) != 0);
        Mag::norm(q, e.saturating_add(i64::from(s)))
    }

    pub fn pow2(k: i64) -> Mag {
        Mag { m: 1, e: k }
    }

    /// An upper bound on `|x|`.
    pub fn of(x: &Fl) -> Mag {
        if x.is_zero() {
            return Mag::ZERO;
        }
        // the leading 64 bits of the mantissa and whether anything below them is set (no allocation: this runs
        // for every radius of every ball operation)
        let n = bitlen(&x.m);
        if n <= 64 {
            return Mag::norm(u128::from(x.m[0]), x.e);
        }
        let shift = n - 64;
        let (li, off) = ((shift / 64) as usize, (shift % 64) as u32);
        let top = if off == 0 { x.m[li] } else { (x.m[li] >> off) | (x.m.get(li + 1).copied().unwrap_or(0) << (64 - off)) };
        let lost = x.m[..li].iter().any(|&w| w != 0) || (off > 0 && x.m[li] & ((1u64 << off) - 1) != 0);
        Mag::norm(u128::from(top) + u128::from(lost), x.e + shift as i64)
    }

    /// A bound on one unit in the last place of a `p`-bit rounding of `x`.
    pub fn ulp(x: &Fl, p: u64) -> Mag {
        if x.is_zero() { Mag::ZERO } else { Mag::pow2(x.top() - p as i64 + 1) }
    }

    pub fn add(self, o: Mag) -> Mag {
        if self.is_inf() || o.is_inf() {
            return Mag::INF;
        }
        if self.is_zero() {
            return o;
        }
        if o.is_zero() {
            return self;
        }
        let (hi, lo) = if self.e >= o.e { (self, o) } else { (o, self) };
        let d = hi.e - lo.e;
        if d > 64 {
            // the smaller term is below one unit of the larger: one more unit covers it
            return Mag::norm(u128::from(hi.m) + 1, hi.e);
        }
        Mag::norm((u128::from(hi.m) << d) + u128::from(lo.m), lo.e)
    }

    pub fn mul(self, o: Mag) -> Mag {
        if self.is_zero() || o.is_zero() {
            return Mag::ZERO;
        }
        if self.is_inf() || o.is_inf() {
            return Mag::INF;
        }
        let e = self.e.checked_add(o.e).unwrap_or(if self.e > 0 { INF_E } else { i64::MIN / 2 });
        if e == INF_E {
            return Mag::INF;
        }
        Mag::norm(u128::from(self.m) * u128::from(o.m), e)
    }

    pub fn pow_up(self, n: u32) -> Mag {
        let mut out = Mag::pow2(0);
        for _ in 0..n {
            out = out.mul(self);
        }
        out
    }

    pub fn mul_2exp(self, k: i64) -> Mag {
        if self.is_zero() || self.is_inf() { self } else { Mag { m: self.m, e: self.e.saturating_add(k) } }
    }

    /// The exact value of the bound (finite only).
    pub fn to_fl(self) -> Fl {
        assert!(!self.is_inf());
        Fl::make(false, vec![self.m], self.e)
    }

    /// The exponent of the leading bit, `i64::MIN` for zero.
    pub fn top(self) -> i64 {
        if self.is_zero() {
            i64::MIN
        } else if self.is_inf() {
            INF_E
        } else {
            self.e + 63 - i64::from(self.m.leading_zeros())
        }
    }

    /// An upper bound of a nonnegative double.
    pub fn from_f64_up(x: f64) -> Mag {
        if x.is_infinite() || x.is_nan() {
            return Mag::INF;
        }
        let f = Fl::from_f64(x.abs());
        Mag::of(&f)
    }

    pub fn le(self, o: Mag) -> bool {
        if o.is_inf() {
            return true;
        }
        if self.is_inf() {
            return false;
        }
        if self.is_zero() {
            return true;
        }
        if o.is_zero() {
            return false;
        }
        let (ta, tb) = (self.top(), o.top());
        if ta != tb {
            return ta < tb;
        }
        // equal leading bits: the exponents differ by less than the 32-bit mantissas, so align in a u128
        let e = self.e.min(o.e);
        (u128::from(self.m) << (self.e - e)) <= (u128::from(o.m) << (o.e - e))
    }
}
