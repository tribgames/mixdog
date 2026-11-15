// Cairo 1.18.6 stroke visibility, translated from cairo-compositor.c,
// cairo-pen.c and cairo-matrix.c. Source: https://cairographics.org/releases/cairo-1.18.6.tar.xz
// SHA256: 1c767308174337a74694da0f3ec069c271452163a1ef4540964c50c301f157d4
//
// Copyright © 2002 University of Southern California
// Copyright © 2008 Chris Wilson
// Copyright © 2011 Intel Corporation
//
// This library is free software; you can redistribute it and/or
// modify it either under the terms of the GNU Lesser General Public
// License version 2.1 as published by the Free Software Foundation
// (the "LGPL") or, at your option, under the terms of the Mozilla
// Public License Version 1.1 (the "MPL"). If you do not alter this
// notice, a recipient may use your version of this file under either
// the MPL or the LGPL.
//
// You should have received a copy of the LGPL along with this library
// in the file COPYING-LGPL-2.1; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Suite 500, Boston, MA 02110-1335, USA.
// You should have received a copy of the MPL along with this library
// in the file COPYING-MPL-1.1.
//
// The contents of this file are subject to the Mozilla Public License
// Version 1.1 (the "License"); you may not use this file except in
// compliance with the License. You may obtain a copy of the License at
// http://www.mozilla.org/MPL/
//
// This software is distributed on an "AS IS" basis, WITHOUT WARRANTY
// OF ANY KIND, either express or implied. See the LGPL or the MPL for
// the specific language governing rights and limitations.
//
// The Original Code is the cairo graphics library.
// The Initial Developer of the Original Code is University of Southern California.
// Contributors: Carl D. Worth <cworth@cworth.org>, Chris Wilson <chris@chris-wilson.co.uk>.
// Copies of both licences accompany this file in ../../licenses/.

/// `_cairo_compositor_stroke_impl` discards a stroke when its transformed pen
/// needs at most one vertex. `_cairo_pen_vertices_needed` makes that decision
/// with the major axis of the pen ellipse, not its area or the scan-converter grid.
pub(super) fn stroke_is_empty(width: f64, [a, b, c, d]: [f64; 4]) -> bool {
    let near = |x: f64, y: f64| (x - y).abs() < 1.0 / 256.0;
    let unity = if near(c, 0.0) && near(b, 0.0) {
        near(a.abs(), 1.0) && near(d.abs(), 1.0)
    } else if near(a, 0.0) && near(d, 0.0) {
        near(c.abs(), 1.0) && near(b.abs(), 1.0)
    } else {
        false
    };
    let radius = width / 2.0;
    let major = if unity {
        radius
    } else {
        let i = a * a + b * b;
        let j = c * c + d * d;
        let f = 0.5 * (i + j);
        let g = 0.5 * (i - j);
        let h = a * c + b * d;
        radius * (f + g.hypot(h)).sqrt()
    };
    // Cairo's default tolerance is a double. Converting 0.1_f32 to f64 here
    // would wrongly discard SVG's parsed 0.05_f32 width, which Cairo paints.
    0.1_f64 >= 4.0 * major
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pen_collapse_boundary_preserves_svg_float_widths() {
        assert!(stroke_is_empty(f64::from(0.049_f32), [1.0, 0.0, 0.0, 1.0]));
        assert!(!stroke_is_empty(f64::from(0.05_f32), [1.0, 0.0, 0.0, 1.0]));
        assert!(!stroke_is_empty(f64::from(0.06_f32), [1.0, 0.0, 0.0, 1.0]));
    }

    #[test]
    fn anisotropic_scale_uses_the_major_axis_not_the_determinant() {
        assert!(!stroke_is_empty(0.04, [2.0, 0.0, 0.0, 0.5]));
        assert!(stroke_is_empty(0.04, [1.0, 0.0, 0.0, 1.0]));
    }
}
