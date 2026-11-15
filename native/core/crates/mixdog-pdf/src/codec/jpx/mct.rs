//! The inverse multiple component transforms of ITU-T T.800 annex G as OpenJPEG 2.5 (`mct.c`) computes them: the
//! reversible component transform (RCT) on integers and the irreversible one (ICT, YCbCr to RGB) on floats, over
//! the first three components of a tile.

/// Inverse RCT: `c0, c1, c2` hold Y, Cb, Cr and are replaced by R, G, B.
pub fn inverse_rct(c0: &mut [i32], c1: &mut [i32], c2: &mut [i32]) {
    for ((a, b), c) in c0.iter_mut().zip(c1.iter_mut()).zip(c2.iter_mut()) {
        let (y, u, v) = (*a, *b, *c);
        let g = y.wrapping_sub(u.wrapping_add(v) >> 2);
        *a = v.wrapping_add(g);
        *b = g;
        *c = u.wrapping_add(g);
    }
}

/// Inverse ICT: `c0, c1, c2` hold Y, Cb, Cr and are replaced by R, G, B.
pub fn inverse_ict(c0: &mut [f32], c1: &mut [f32], c2: &mut [f32]) {
    for ((a, b), c) in c0.iter_mut().zip(c1.iter_mut()).zip(c2.iter_mut()) {
        let (y, u, v) = (*a, *b, *c);
        *a = y + v * 1.402;
        *b = y - u * 0.34413 - v * 0.71414;
        *c = y + u * 1.772;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rct_inverts_the_forward_transform() {
        for (r, g, b) in [(0, 0, 0), (255, 255, 255), (10, 200, 77), (-128, 127, 3), (1, 2, 3)] {
            let y = (r + 2 * g + b) >> 2;
            let (u, v) = (b - g, r - g);
            let (mut c0, mut c1, mut c2) = ([y], [u], [v]);
            inverse_rct(&mut c0, &mut c1, &mut c2);
            assert_eq!((c0[0], c1[0], c2[0]), (r, g, b));
        }
    }

    #[test]
    fn ict_of_a_grey_sample_stays_grey_and_follows_the_coefficients() {
        let (mut c0, mut c1, mut c2) = ([100.0f32], [0.0], [0.0]);
        inverse_ict(&mut c0, &mut c1, &mut c2);
        assert_eq!((c0[0], c1[0], c2[0]), (100.0, 100.0, 100.0));
        let (mut c0, mut c1, mut c2) = ([50.0f32], [10.0], [20.0]);
        inverse_ict(&mut c0, &mut c1, &mut c2);
        assert!((c0[0] - 78.04).abs() < 1e-3);
        assert!((c1[0] - (50.0 - 3.4413 - 14.2828)).abs() < 1e-3);
        assert!((c2[0] - 67.72).abs() < 1e-3);
    }
}
