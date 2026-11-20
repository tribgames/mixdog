//! Truncated power series with ball coefficients (Taylor arithmetic). Evaluated with a ball as the expansion point,
//! coefficient j encloses f^(j)(xi)/j! for every xi in that ball, which is what the panel remainder needs.

use super::ball::B;

#[derive(Clone, Debug)]
pub struct Ser(pub Vec<B>);

impl Ser {
    pub fn zeros(n: usize) -> Ser {
        Ser(vec![B::zero(); n])
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// exp of a series whose constant term is `c0` already exponentiated by the caller: returns the series of
    /// `exp(f - f0)`, i.e. with constant 1 (f' = g' f recurrence: j f_j = sum_k k g_k f_(j-k)).
    pub fn exp_shifted(&self) -> Ser {
        let n = self.len();
        let mut f = Ser::zeros(n);
        f.0[0] = B::one();
        for j in 1..n {
            let mut s = B::zero();
            for k in 1..=j {
                if !self.0[k].is_exact_zero() {
                    s = s.add(&self.0[k].mul(&f.0[j - k]).mul_int(k as i64));
                }
            }
            f.0[j] = s.div_int(j as i64);
        }
        f
    }

    /// The non-constant part of log(1 + w): L' = w' / (1 + w) (the constant term is left zero for the caller,
    /// who forms it in centred form).
    pub fn log1p_tail(&self) -> Ser {
        let n = self.len();
        let inv = self.0[0].add(&B::one()).recip();
        let dw: Vec<B> = (0..n - 1).map(|j| self.0[j + 1].mul_int(j as i64 + 1)).collect();
        let mut q: Vec<B> = Vec::with_capacity(n - 1);
        for j in 0..n - 1 {
            let mut s = dw[j].clone();
            for k in 1..=j {
                if !self.0[k].is_exact_zero() {
                    s = s.sub(&self.0[k].mul(&q[j - k]));
                }
            }
            q.push(s.mul(&inv));
        }
        let mut out = Ser::zeros(n);
        for j in 1..n {
            out.0[j] = q[j - 1].div_int(j as i64);
        }
        out
    }
}
