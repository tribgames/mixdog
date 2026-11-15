//! The inverse discrete wavelet transforms of ITU-T T.800 annex F as OpenJPEG 2.5 (`dwt.c`) computes them: the
//! reversible 5/3 transform on 32-bit integers and the irreversible 9/7 transform on 32-bit floats, in the order and
//! with the constants and rounding OpenJPEG uses.
//!
//! A tile-component's samples lie in one buffer: the lowest resolution in the top-left corner, and each higher
//! resolution as the buffer's top-left `width x height` area whose four quadrants are the previous resolution (LL)
//! and the HL, LH and HH sub-bands. Every level interleaves a row (then a column) from the quadrants, filters it
//! and writes it back in place.

/// The area of one resolution of a tile-component, in resolution coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResBox {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl ResBox {
    fn width(&self) -> usize {
        (self.x1 - self.x0) as usize
    }

    fn height(&self) -> usize {
        (self.y1 - self.y0) as usize
    }
}

/// The 9/7 lifting constants of OpenJPEG; the high-pass scale is 2/K because its decoder takes the sub-band gains of
/// the irreversible path as 0 (see `tiles::build_resolution`).
const ALPHA: f32 = 1.586_134_3;
const BETA: f32 = 0.052_980_117;
const GAMMA: f32 = -0.882_911_08;
const DELTA: f32 = -0.443_506_85;
const K: f32 = 1.230_174_1;
const TWICE_INV_K: f32 = 1.625_732_4;

/// Inverse 5/3 transform of all resolutions (`resolutions[0]` is the lowest) of a component in `data`, whose rows
/// are `stride` samples apart.
pub fn inverse_reversible(data: &mut [i32], stride: usize, resolutions: &[ResBox]) {
    inverse(data, stride, resolutions, lift_53);
}

/// Inverse 9/7 transform; see [`inverse_reversible`].
pub fn inverse_irreversible(data: &mut [f32], stride: usize, resolutions: &[ResBox]) {
    inverse(data, stride, resolutions, lift_97);
}

fn inverse<T: Copy + Default>(data: &mut [T], stride: usize, resolutions: &[ResBox], lift: fn(&mut [T], usize)) {
    if stride == 0 {
        return;
    }
    for level in 1..resolutions.len() {
        let (prev, cur) = (resolutions[level - 1], resolutions[level]);
        let (rw, rh) = (cur.width(), cur.height());
        let mut line = vec![T::default(); rw.max(rh)];
        if rw > 0 {
            let (sn, cas) = (prev.width(), (cur.x0 & 1) as usize);
            for row in data.chunks_mut(stride).take(rh) {
                interleave(&mut line[..rw], |k| row[k], sn, cas);
                lift(&mut line[..rw], cas);
                row[..rw].copy_from_slice(&line[..rw]);
            }
        }
        if rh > 0 {
            let (sn, cas) = (prev.height(), (cur.y0 & 1) as usize);
            for x in 0..rw {
                interleave(&mut line[..rh], |k| data[k * stride + x], sn, cas);
                lift(&mut line[..rh], cas);
                for (k, v) in line[..rh].iter().enumerate() {
                    data[k * stride + x] = *v;
                }
            }
        }
    }
}

/// `opj_dwt_interleave`: the first `sn` values of the source are the low-pass samples, the rest the high-pass
/// samples; the low ones go to the positions of parity `cas`.
fn interleave<T: Copy>(out: &mut [T], source: impl Fn(usize) -> T, sn: usize, cas: usize) {
    for k in 0..out.len() {
        let dest = if k < sn { cas + 2 * k } else { 1 - cas + 2 * (k - sn) };
        out[dest] = source(k);
    }
}

/// The neighbours of position `i` in a line of `n >= 2` samples, mirrored at both ends (whole-sample symmetry).
fn neighbours(i: usize, n: usize) -> (usize, usize) {
    (if i == 0 { 1 } else { i - 1 }, if i + 1 >= n { i - 1 } else { i + 1 })
}

fn lift_53(x: &mut [i32], cas: usize) {
    let n = x.len();
    if n < 2 {
        if n == 1 && cas == 1 {
            x[0] /= 2;
        }
        return;
    }
    for i in (cas..n).step_by(2) {
        let (l, r) = neighbours(i, n);
        x[i] = x[i].wrapping_sub(x[l].wrapping_add(x[r]).wrapping_add(2) >> 2);
    }
    for i in ((1 - cas)..n).step_by(2) {
        let (l, r) = neighbours(i, n);
        x[i] = x[i].wrapping_add(x[l].wrapping_add(x[r]) >> 1);
    }
}

fn lift_97(x: &mut [f32], cas: usize) {
    let n = x.len();
    if n < 2 {
        return;
    }
    for i in (cas..n).step_by(2) {
        x[i] *= K;
    }
    for i in ((1 - cas)..n).step_by(2) {
        x[i] *= TWICE_INV_K;
    }
    for (parity, c) in [(cas, DELTA), (1 - cas, GAMMA), (cas, BETA), (1 - cas, ALPHA)] {
        for i in (parity..n).step_by(2) {
            let (l, r) = neighbours(i, n);
            x[i] += (x[l] + x[r]) * c;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The forward 5/3 transform of one line (T.800 F.4.8.1), to check the inverse against.
    fn forward_53(x: &[i32], cas: usize) -> Vec<i32> {
        let n = x.len();
        let mut y = x.to_vec();
        for i in ((1 - cas)..n).step_by(2) {
            let (l, r) = neighbours(i, n);
            y[i] -= (x[l] + x[r]) >> 1;
        }
        let high = y.clone();
        for i in (cas..n).step_by(2) {
            let (l, r) = neighbours(i, n);
            y[i] += (high[l] + high[r] + 2) >> 2;
        }
        y
    }

    #[test]
    fn reversible_transform_inverts_the_forward_transform_of_a_line() {
        for cas in 0..2usize {
            for n in 2..12usize {
                let x: Vec<i32> = (0..n as i32).map(|i| (i * 37 + 11) % 61 - 20).collect();
                let mut y = forward_53(&x, cas);
                lift_53(&mut y, cas);
                assert_eq!(y, x, "n {n} cas {cas}");
            }
        }
    }

    #[test]
    fn a_single_high_pass_sample_is_halved_and_a_single_low_pass_sample_kept() {
        let mut one = [9];
        lift_53(&mut one, 1);
        assert_eq!(one, [4]);
        let mut one = [9];
        lift_53(&mut one, 0);
        assert_eq!(one, [9]);
        let mut f = [9.0f32];
        lift_97(&mut f, 1);
        assert_eq!(f, [9.0]);
    }

    #[test]
    fn irreversible_transform_of_a_flat_low_band_is_flat() {
        // A constant signal has only low-pass coefficients (the DC gain of the low-pass band is 1): the inverse of
        // (1, 0, 1, 0, ...) is the constant 1.
        let mut x = [0.0f32; 8];
        for i in (0..8).step_by(2) {
            x[i] = 1.0;
        }
        lift_97(&mut x, 0);
        for v in &x {
            assert!((v - x[0]).abs() < 1e-4, "{x:?}");
        }
    }

    #[test]
    fn two_levels_in_place_restore_a_plane() {
        // A 4x4 plane whose resolutions are 1x1, 2x2 and 4x4: every sample 0 except the LL sample decodes flat.
        let res = [
            ResBox { x0: 0, y0: 0, x1: 1, y1: 1 },
            ResBox { x0: 0, y0: 0, x1: 2, y1: 2 },
            ResBox { x0: 0, y0: 0, x1: 4, y1: 4 },
        ];
        let mut data = [0i32; 16];
        data[0] = 8;
        inverse_reversible(&mut data, 4, &res);
        assert!(data.iter().all(|&v| v == 8), "{data:?}");
    }
}
