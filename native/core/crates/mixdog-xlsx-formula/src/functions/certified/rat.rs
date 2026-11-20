//! Exact rationals of dyadic numerator and positive dyadic denominator (no reduction; the operands are doubles and
//! short sums and products of them). Used wherever exact zero, a sign or a cancellation decides a branch: standard
//! scores, distances to a mode, range statistics.

use super::ball::B;
use super::num::Fl;
use std::cmp::Ordering;

#[derive(Clone, Debug)]
pub struct Rat {
    pub n: Fl,
    pub d: Fl,
}

impl Rat {
    pub fn fl(n: Fl) -> Rat {
        Rat { n, d: Fl::from_i64(1) }
    }

    pub fn f(x: f64) -> Rat {
        Rat::fl(Fl::from_f64(x))
    }

    pub fn int(v: i64) -> Rat {
        Rat::fl(Fl::from_i64(v))
    }

    pub fn add(&self, o: &Rat) -> Rat {
        if self.d == o.d {
            return Rat { n: self.n.add(&o.n), d: self.d.clone() };
        }
        Rat { n: self.n.mul(&o.d).add(&o.n.mul(&self.d)), d: self.d.mul(&o.d) }
    }

    pub fn neg(&self) -> Rat {
        Rat { n: self.n.neg(), d: self.d.clone() }
    }

    pub fn sub(&self, o: &Rat) -> Rat {
        self.add(&o.neg())
    }

    pub fn mul(&self, o: &Rat) -> Rat {
        Rat { n: self.n.mul(&o.n), d: self.d.mul(&o.d) }
    }

    /// `self / o`, `o` nonzero.
    pub fn div(&self, o: &Rat) -> Rat {
        let (n, d) = (self.n.mul(&o.d), self.d.mul(&o.n));
        if d.is_neg() { Rat { n: n.neg(), d: d.neg() } } else { Rat { n, d } }
    }

    pub fn mul_2exp(&self, k: i64) -> Rat {
        Rat { n: self.n.mul_2exp(k), d: self.d.clone() }
    }

    pub fn is_zero(&self) -> bool {
        self.n.is_zero()
    }

    pub fn sign(&self) -> Ordering {
        if self.n.is_zero() {
            Ordering::Equal
        } else if self.n.is_neg() {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }

    pub fn cmp(&self, o: &Rat) -> Ordering {
        self.sub(o).sign()
    }

    /// The ball of the quotient at the working precision.
    pub fn ball(&self) -> B {
        if self.d == Fl::from_i64(1) {
            return B::exact(self.n.clone());
        }
        // a quotient equal to one is exact (canonical dyadics compare by value): its logarithm is the exact zero
        // that puts a cut on a mode, which no precision of a divided ball would decide
        if self.n == self.d {
            return B::one();
        }
        B::exact(self.n.clone()).div(&B::exact(self.d.clone()))
    }

    /// The logarithm of a positive quotient. Near one it is `log1p` of the exact excess `(n - d)/d`, so a cut a
    /// relative 1e-300 from a mode (huge shapes, whose peaks are that narrow) keeps its distance, which the logarithm
    /// of a rounded quotient would lose; exactly one gives the exact zero.
    pub fn ln(&self) -> B {
        if self.n == self.d {
            return B::zero();
        }
        let excess = Rat { n: self.n.sub(&self.d), d: self.d.clone() };
        if excess.n.top() < excess.d.top() - 1 { super::ball::log1p(&excess.ball()) } else { super::ball::ln(&self.ball()) }
    }

    /// The nearest double (through a ball at 128 bits; exact rationals of doubles never sit within 2^-128 of a
    /// rounding boundary unless they are on it, and then the midpoint is exact).
    pub fn to_f64(&self) -> f64 {
        super::ball::with_prec(160, || self.ball().to_f64())
    }
}
