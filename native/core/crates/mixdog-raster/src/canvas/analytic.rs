//! Analytic path coverage, ported from Skia's fixed-point trapezoid rasterizer.
//! Source: google/skia 95ee33d7ec7791ab9c071675710a14fe6408ae4f,
//! the skia submodule of @napi-rs/canvas v1.0.11 (not upstream HEAD).
//! `src/core/SkScan_AAAPath.cpp` (Copyright 2016 The Android Open Source Project)
//! `src/core/SkAnalyticEdge.{h,cpp}` (Copyright 2006 The Android Open Source Project),
//! and `src/core/SkPathPriv.cpp` (convexity classification).
//! Integer rounding and the small-triangle fast paths are observable pixel behavior.
//!
//! Upstream license (retained for the translated routines below):
//! Copyright (c) 2011 Google Inc. All rights reserved.
//!
//! Redistribution and use in source and binary forms, with or without
//! modification, are permitted provided that the following conditions are
//! met:
//!
//!   * Redistributions of source code must retain the above copyright
//!     notice, this list of conditions and the following disclaimer.
//!
//!   * Redistributions in binary form must reproduce the above copyright
//!     notice, this list of conditions and the following disclaimer in
//!     the documentation and/or other materials provided with the
//!     distribution.
//!
//!   * Neither the name of the copyright holder nor the names of its
//!     contributors may be used to endorse or promote products derived
//!     from this software without specific prior written permission.
//!
//! THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
//! "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
//! LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
//! A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
//! OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
//! SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
//! LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
//! DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
//! THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
//! (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
//! OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

use tiny_skia::{FillRule, Path, PathSegment};

use super::glyph::Raster;

type Point = (f32, f32);

/// `SkScalarToFDot6(x * 4)`: the point of an edge in 1/256 pixel, truncated.
fn fdot(value: f32) -> i32 {
    (value * 256.0) as i32
}

/// `diff_to_shift`: how many halvings of a curve bring its distance from its chord under the accuracy Skia wants.
fn diff_to_shift(dx: i32, dy: i32, shift_aa: i32) -> i32 {
    let (dx, dy) = (dx.abs(), dy.abs());
    let dist = if dx > dy { dx + (dy >> 1) } else { dy + (dx >> 1) };
    let dist = (dist + (1 << 4)) >> (3 + shift_aa);
    let bits = 32 - (dist.max(0) as u32).leading_zeros() as i32;
    bits >> 1
}

fn interpolate(a: Point, b: Point, t: f32) -> Point {
    (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
}

/// `valid_unit_divide`: `numer / denom` when it lies strictly between 0 and 1.
fn valid_unit_divide(mut numer: f32, mut denom: f32) -> Option<f32> {
    if numer < 0.0 {
        numer = -numer;
        denom = -denom;
    }
    if denom == 0.0 || numer == 0.0 || numer >= denom {
        return None;
    }
    let ratio = numer / denom;
    if ratio.is_nan() || ratio == 0.0 { None } else { Some(ratio) }
}

/// `SkFindUnitQuadRoots`: the roots of `a t^2 + b t + c` strictly between 0 and 1, ascending and distinct.
fn unit_quad_roots(a: f32, b: f32, c: f32) -> Vec<f32> {
    if a == 0.0 {
        return valid_unit_divide(-c, b).into_iter().collect();
    }
    let discriminant = f64::from(b) * f64::from(b) - 4.0 * f64::from(a) * f64::from(c);
    if discriminant < 0.0 {
        return Vec::new();
    }
    let root = discriminant.sqrt() as f32;
    if !root.is_finite() {
        return Vec::new();
    }
    let q = if b < 0.0 { -(b - root) / 2.0 } else { -(b + root) / 2.0 };
    let mut roots: Vec<f32> = Vec::new();
    roots.extend(valid_unit_divide(q, a));
    roots.extend(valid_unit_divide(c, q));
    if roots.len() == 2 {
        if roots[0] > roots[1] {
            roots.swap(0, 1);
        } else if roots[0] == roots[1] {
            roots.pop();
        }
    }
    roots
}

/// `SkChopQuadAtYExtrema`: the quad as one or two pieces whose y is monotonic.
fn chop_quad(p: [Point; 3]) -> Vec<[Point; 3]> {
    let (a, mut b, c) = (p[0].1, p[1].1, p[2].1);
    let ab = a - b;
    let mut bc = b - c;
    if ab < 0.0 {
        bc = -bc;
    }
    if ab == 0.0 || bc < 0.0 {
        if let Some(t) = valid_unit_divide(a - b, a - b - b + c) {
            let p01 = interpolate(p[0], p[1], t);
            let p12 = interpolate(p[1], p[2], t);
            let mid = interpolate(p01, p12, t);
            // The control points beside the extremum take its y.
            return vec![[p[0], (p01.0, mid.1), mid], [mid, (p12.0, mid.1), p[2]]];
        }
        b = if (a - b).abs() < (b - c).abs() { a } else { c };
    }
    vec![[(p[0].0, a), (p[1].0, b), (p[2].0, c)]]
}

/// `SkChopCubicAt` at one parameter.
fn chop_cubic_at(p: [Point; 4], t: f32) -> ([Point; 4], [Point; 4]) {
    let ab = interpolate(p[0], p[1], t);
    let bc = interpolate(p[1], p[2], t);
    let cd = interpolate(p[2], p[3], t);
    let abc = interpolate(ab, bc, t);
    let bcd = interpolate(bc, cd, t);
    let abcd = interpolate(abc, bcd, t);
    ([p[0], ab, abc, abcd], [abcd, bcd, cd, p[3]])
}

/// `SkChopCubicAtYExtrema`: the cubic as up to three pieces whose y is monotonic, the control points beside an extremum
/// flattened onto it.
fn chop_cubic(p: [Point; 4]) -> Vec<[Point; 4]> {
    let (a, b, c, d) = (p[0].1, p[1].1, p[2].1, p[3].1);
    let roots = unit_quad_roots(d - a + 3.0 * (b - c), 2.0 * (a - b - b + c), b - a);
    if roots.is_empty() {
        return vec![p];
    }
    let mut pieces: Vec<[Point; 4]> = Vec::new();
    let mut rest = p;
    let mut t = roots[0];
    for index in 0..roots.len() {
        let (head, tail) = chop_cubic_at(rest, t);
        pieces.push(head);
        rest = tail;
        if index == roots.len() - 1 {
            pieces.push(rest);
            break;
        }
        match valid_unit_divide(roots[index + 1] - roots[index], 1.0 - roots[index]) {
            Some(next) => t = next,
            None => {
                pieces.push([rest[3], rest[3], rest[3], rest[3]]);
                break;
            }
        }
    }
    for at in 0..roots.len().min(2) {
        if at + 1 >= pieces.len() {
            break;
        }
        let extremum = pieces[at][3].1;
        pieces[at][2].1 = extremum;
        pieces[at + 1][1].1 = extremum;
    }
    pieces
}

fn cubic_delta_from_line(a: i32, b: i32, c: i32, d: i32) -> i32 {
    let one_third = ((a * 8 - b * 15 + 6 * c + d) * 19) >> 9;
    let two_third = ((a + 6 * b - c * 15 + d * 8) * 19) >> 9;
    one_third.abs().max(two_third.abs())
}

/// One edge of the path: from its top point to its bottom point (the points held as Skia's analytic edges hold them), and
/// whether the path ran down it (the winding).
#[derive(Clone, Copy)]
enum CurveStep {
    Line,
    Quad { to: (i32, i32) },
    Cubic { last: bool },
}
struct Edge {
    top: (i32, i32),
    bottom: (i32, i32),
    dx: i32,
    dy: i32,
    down: bool,
    group: usize,
    smooth: bool,
    id: usize,
    raw_bottom: (i32, i32),
    step: CurveStep,
}

/// `SkAnalyticEdge::updateLine`: an edge from `a` to `b` (16.16 pixels). Its slope is the quotient of the two differences held
/// to 1/64 of a pixel (`quick_div` of `SkFixedToFDot6`), and the edge runs down its rows by that slope from its top point, so
/// the x it ends at is the top x plus the slope times the height, not the x it was asked to end at.
fn put(edges: &mut Vec<Edge>, a: (i32, i32), b: (i32, i32), down: bool) {
    let rise = (b.1 - a.1) >> 10;
    if rise == 0 {
        return;
    }
    let slope = ((i64::from((b.0 - a.0) >> 10) << 16) / i64::from(rise)) as i32;
    put_slope(edges, a, b, down, slope);
}
fn put_slope(edges: &mut Vec<Edge>, a: (i32, i32), b: (i32, i32), down: bool, slope: i32) {
    let (top, bottom, down) = if a.1 <= b.1 { (a, b, down) } else { (b, a, !down) };
    let rise = (bottom.1 - top.1) >> 10;
    if rise == 0 {
        return;
    }
    let run = (bottom.0 - top.0) >> 10;
    let abs_slope = (slope >> 10).abs();
    let dy = if run == 0 || slope == 0 {
        i32::MAX
    } else if abs_slope < 1024 {
        quick_inverse(abs_slope)
    } else {
        quick_div(rise, run).abs()
    };
    edges.push(Edge {
        top,
        bottom: (top.0.wrapping_add(fixed_mul(slope, bottom.1 - top.1)), bottom.1),
        dx: slope,
        dy,
        down,
        group: edges.len(),
        smooth: false,
        id: edges.len(),
        raw_bottom: bottom,
        step: CurveStep::Line,
    });
}

/// `SkAnalyticEdge::setLine`: x truncated to 1/256 of a pixel, y held to a quarter; a line that is flat after that is no edge.
fn line(edges: &mut Vec<Edge>, a: Point, b: Point) {
    let fixed = |point: Point| (fdot(point.0) << 8, snap_fixed(fdot(point.1) << 8));
    let before = edges.len();
    put(edges, fixed(a), fixed(b), true);
    if let Some(edge) = edges.get_mut(before) {
        let (a, b) = (fixed(a), fixed(b));
        let (a, b) = if a.1 <= b.1 { (a, b) } else { (b, a) };
        let (run, rise) = ((b.0 - a.0) >> 10, (b.1 - a.1) >> 10);
        edge.dx = quick_div(run, rise);
        edge.bottom.0 = a.0.wrapping_add(fixed_mul(edge.dx, b.1 - a.1));
        let abs_slope = edge.dx.abs();
        edge.dy = if run == 0 || edge.dx == 0 {
            i32::MAX
        } else if abs_slope < 1024 {
            quick_inverse(abs_slope)
        } else {
            quick_div(rise, run).abs()
        };
    }
}

/// `SnapY` on a 16.16 value: a quarter of a pixel, rounded half up.
fn snap_fixed(y: i32) -> i32 {
    ((((y as u32).wrapping_add(0x2000)) >> 14) << 14) as i32
}

// The 1025-entry upstream reciprocal table is precisely trunc(2^22 / x).
fn quick_inverse(x: i32) -> i32 {
    if x == 0 { 0 } else { (1 << 22) / x }
}
fn quick_div(a: i32, b: i32) -> i32 {
    // SkAnalyticEdge.cpp: kMaxBits=31, kMinBits=3,
    // kMaxAbsA = 1 << (31 - (22 - 3)) = 4096. The reciprocal multiply
    // deliberately differs by a few fixed-point units from integer division.
    if (8..1024).contains(&b.abs()) && a.abs() < 4096 {
        (a * quick_inverse(b)) >> 6
    } else {
        ((i64::from(a) << 16) / i64::from(b)).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
    }
}

/// `SkQuadraticEdge::setQuadraticWithoutUpdate` and `SkAnalyticQuadraticEdge::updateQuadratic`: one monotonic piece of a quad
/// walked from the top down by forward differencing in 16.16 (the start y snapped to a quarter pixel before the walk, as
/// `setQuadratic` does), each step's y snapped to a quarter pixel; a step of two pixels or more is snapped to a whole pixel with
/// its x moved along the chord. A step that ends on the y the last chord ended on makes no chord; the next one starts from
/// where the last ended.
fn quad_edges(edges: &mut Vec<Edge>, piece: [Point; 3]) {
    let group = edges.len();
    let mut down = true;
    let mut q = [fdot(piece[0].0), fdot(piece[0].1), fdot(piece[1].0), fdot(piece[1].1), fdot(piece[2].0), fdot(piece[2].1)];
    if q[1] > q[5] {
        q.swap(0, 4);
        q.swap(1, 5);
        down = false;
    }
    let (x0, y0, x1, y1, x2, y2) = (q[0], q[1], q[2], q[3], q[4], q[5]);
    if ((y0 + 32) >> 6) == ((y2 + 32) >> 6) {
        return;
    }
    let (dx, dy) = (((x1 << 1) - x0 - x2) >> 2, ((y1 << 1) - y0 - y2) >> 2);
    let shift = diff_to_shift(dx, dy, 2).clamp(1, 6);
    let coefficients = |a0: i32, a1: i32, a2: i32| {
        let a = (a0 - a1 - a1 + a2) << 9;
        let b = (a1 - a0) << 10;
        let start = a0 << 10;
        let first = b + (a >> shift);
        let second = a >> (shift - 1);
        (start >> 2, first >> 2, second >> 2)
    };
    let (qx, mut cdx, ddx) = coefficients(x0, x1, x2);
    let (qy, mut cdy, ddy) = coefficients(y0, y1, y2);
    let last_x = (x2 << 10) >> 2;
    let last_y = snap_fixed((y2 << 10) >> 2);
    let (mut old_x, mut old_y) = (qx, snap_fixed(qy));
    let (mut snapped_x, mut snapped_y) = (old_x, old_y);
    let mut count = 1_i32 << shift;
    loop {
        count -= 1;
        let (new_x, new_y, new_snapped_x, new_snapped_y, edge_slope, slope_y);
        if count > 0 {
            new_x = old_x.wrapping_add(cdx >> (shift - 1));
            new_y = old_y.wrapping_add(cdy >> (shift - 1));
            if (cdy >> (shift - 1)).abs() >= 2 << 16 && (i64::from(cdy.abs()) << 6) > i64::from(cdx.abs()) {
                let rise = (new_y - snapped_y) >> 10;
                slope_y = new_y;
                let slope = if rise != 0 { quick_div((new_x - snapped_x) >> 10, rise) } else { i32::MAX };
                edge_slope = slope;
                new_snapped_y = last_y.min((new_y.wrapping_add(0x8000)) & !0xFFFF);
                new_snapped_x = new_x.wrapping_sub(((i64::from(slope) * i64::from(new_y - new_snapped_y)) >> 16) as i32);
            } else {
                new_snapped_y = last_y.min(snap_fixed(new_y));
                new_snapped_x = new_x;
                let rise = (new_snapped_y - snapped_y) >> 10;
                slope_y = new_snapped_y;
                edge_slope = if rise == 0 { i32::MAX } else { quick_div((new_x - snapped_x) >> 10, rise) };
            }
            cdx = cdx.wrapping_add(ddx);
            cdy = cdy.wrapping_add(ddy);
        } else {
            new_x = last_x;
            new_y = last_y;
            new_snapped_y = new_y;
            new_snapped_x = new_x;
            let rise = (new_y - snapped_y) >> 10;
            slope_y = new_y;
            edge_slope = if rise == 0 { i32::MAX } else { quick_div((new_x - snapped_x) >> 10, rise) };
        }
        if (new_snapped_y - snapped_y) >> 10 != 0 {
            put_slope(edges, (snapped_x, snapped_y), (new_snapped_x, new_snapped_y), down, edge_slope);
            if let Some(e) = edges.last_mut() {
                e.group = group;
                e.step = CurveStep::Quad { to: (new_x, slope_y) };
                e.smooth = count > 0 && (cdx.abs() >> 1) >= ddx.abs() && (cdy.abs() >> 1) >= ddy.abs() && ((cdy - ddy) >> (shift - 1)) >= ONE;
            }
            snapped_x = new_snapped_x;
            snapped_y = new_snapped_y;
        }
        old_x = new_x;
        old_y = new_y;
        if count <= 0 {
            break;
        }
    }
}

/// `SkCubicEdge::setCubicWithoutUpdate` and `SkAnalyticCubicEdge::updateCubic`: one monotonic piece of a cubic walked from
/// the top down by forward differencing in 16.16 (the start y snapped to a quarter pixel before the walk); each step's y is
/// snapped to a quarter pixel, never above the step before and never below the last point.
fn cubic_edges(edges: &mut Vec<Edge>, piece: [Point; 4]) {
    let group = edges.len();
    let mut down = true;
    let mut c =
        [fdot(piece[0].0), fdot(piece[0].1), fdot(piece[1].0), fdot(piece[1].1), fdot(piece[2].0), fdot(piece[2].1), fdot(piece[3].0), fdot(piece[3].1)];
    if c[1] > c[7] {
        c.swap(0, 6);
        c.swap(1, 7);
        c.swap(2, 4);
        c.swap(3, 5);
        down = false;
    }
    let (x0, y0, x1, y1, x2, y2, x3, y3) = (c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
    if ((y0 + 32) >> 6) == ((y3 + 32) >> 6) {
        return;
    }
    let (dx, dy) = (cubic_delta_from_line(x0, x1, x2, x3), cubic_delta_from_line(y0, y1, y2, y3));
    let shift = (diff_to_shift(dx, dy, 2) + 1).min(6);
    let (mut up_shift, mut down_shift) = (6, shift + 6 - 10);
    if down_shift < 0 {
        down_shift = 0;
        up_shift = 10 - shift;
    }
    let coefficients = |a0: i32, a1: i32, a2: i32, a3: i32| {
        let b = (3 * (a1 - a0)) << up_shift;
        let c = (3 * (a0 - a1 - a1 + a2)) << up_shift;
        let d = (a3 + 3 * (a1 - a2) - a0) << up_shift;
        let start = a0 << 10;
        let first = b + (c >> shift) + (d >> (2 * shift));
        let second = 2 * c + ((3 * d) >> (shift - 1));
        let third = (3 * d) >> (shift - 1);
        (start >> 2, first >> 2, second >> 2, third >> 2)
    };
    let (cx, mut cdx, mut cddx, cdddx) = coefficients(x0, x1, x2, x3);
    let (cy, mut cdy, mut cddy, cddly) = coefficients(y0, y1, y2, y3);
    let last_x = (x3 << 10) >> 2;
    let last_y = snap_fixed((y3 << 10) >> 2);
    let (mut old_x, mut old_y) = (cx, snap_fixed(cy));
    let mut snapped_y = old_y;
    let mut count = -(1_i32 << shift);
    loop {
        count += 1;
        let (new_x, mut new_y);
        if count < 0 {
            new_x = old_x.wrapping_add(cdx >> down_shift);
            cdx = cdx.wrapping_add(cddx >> shift);
            cddx = cddx.wrapping_add(cdddx);
            new_y = old_y.wrapping_add(cdy >> down_shift);
            cdy = cdy.wrapping_add(cddy >> shift);
            cddy = cddy.wrapping_add(cddly);
        } else {
            new_x = last_x;
            new_y = last_y;
        }
        if new_y < old_y {
            new_y = old_y;
        }
        let new_snapped_y = snap_fixed(new_y).min(last_y);
        if (new_snapped_y - snapped_y) >> 10 != 0 {
            put(edges, (old_x, snapped_y), (new_x, new_snapped_y), down);
            if let Some(e) = edges.last_mut() {
                e.group = group;
                e.step = CurveStep::Cubic { last: count >= 0 };
                e.smooth = count < 0
                    && (cdx.abs() >> 1) >= (cddx.abs() >> shift)
                    && (cdy.abs() >> 1) >= (cddy.abs() >> shift)
                    && ((cdy - (cddy >> shift)) >> down_shift) >= ONE;
            }
        }
        old_x = new_x;
        old_y = new_y;
        snapped_y = new_snapped_y;
        if count >= 0 {
            break;
        }
    }
}

/// The edges Skia builds from a path (`SkEdgeBuilder`), every contour closed.
fn edges(path: &Path) -> Vec<Edge> {
    let mut out: Vec<Edge> = Vec::new();
    let mut start: Point = (0.0, 0.0);
    let mut last: Point = (0.0, 0.0);
    let mut open = false;
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(p) => {
                if open {
                    line(&mut out, last, start);
                }
                start = (p.x, p.y);
                last = start;
                open = true;
            }
            PathSegment::LineTo(p) => {
                line(&mut out, last, (p.x, p.y));
                last = (p.x, p.y);
            }
            PathSegment::QuadTo(c, p) => {
                for piece in chop_quad([last, (c.x, c.y), (p.x, p.y)]) {
                    quad_edges(&mut out, piece);
                }
                last = (p.x, p.y);
            }
            PathSegment::CubicTo(c1, c2, p) => {
                for piece in chop_cubic([last, (c1.x, c1.y), (c2.x, c2.y), (p.x, p.y)]) {
                    cubic_edges(&mut out, piece);
                }
                last = (p.x, p.y);
            }
            PathSegment::Close => {
                line(&mut out, last, start);
                last = start;
                open = false;
            }
        }
    }
    if open {
        line(&mut out, last, start);
    }
    out
}

/// The rectangle a path is when it is one contour of four sides along the axes that has a whole pixel across (`SkPath::isRect`
/// drawn by `SkScan::AntiFillRect`, which leaves the exact area of every pixel; a rectangle without a whole pixel across is
/// drawn as any other path), as left, top, right, bottom.
fn axis_rect(path: &Path) -> Option<(f32, f32, f32, f32)> {
    let mut points: Vec<Point> = Vec::with_capacity(5);
    let mut closed = false;
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(p) if points.is_empty() => points.push((p.x, p.y)),
            PathSegment::LineTo(p) if !points.is_empty() && !closed => points.push((p.x, p.y)),
            PathSegment::Close if !closed => closed = true,
            _ => return None,
        }
        if points.len() > 5 {
            return None;
        }
    }
    if points.len() == 5 && points[4] == points[0] {
        points.pop();
    }
    if points.len() != 4 || !(0..4).all(|i| points[i].0 == points[(i + 1) % 4].0 || points[i].1 == points[(i + 1) % 4].1) {
        return None;
    }
    let (left, right) = (points.iter().map(|p| p.0).fold(f32::INFINITY, f32::min), points.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max));
    let (top, bottom) = (points.iter().map(|p| p.1).fold(f32::INFINITY, f32::min), points.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max));
    if (right.floor() - left.ceil()) < 1.0 || points[0].0 == points[2].0 || points[0].1 == points[2].1 {
        return None;
    }
    Some((left, top, right, bottom))
}

/// `AntiFillRect`: the share of each pixel the rectangle covers, in 255ths, rounded down.
fn exact_rect(rect: (f32, f32, f32, f32), left: usize, top: usize, width: usize, height: usize) -> Raster {
    let overlap = |from: f32, to: f32, at: usize| (to.min(at as f32 + 1.0) - from.max(at as f32)).clamp(0.0, 1.0);
    let mut data = vec![0_u8; width * height];
    for row in 0..height {
        let vertical = overlap(rect.1, rect.3, top + row);
        for column in 0..width {
            let share = overlap(rect.0, rect.2, left + column) * vertical;
            data[row * width + column] = (share * 255.0 + 0.001) as u8;
        }
    }
    Raster { left, top, width, height, data }
}

/// The coverage of `path` in device pixels, computed by fixed-point winding intervals
/// and the pinned Skia row blitter; `None` when the path touches no pixel.
pub(crate) fn coverage(path: &Path, rule: FillRule, canvas_width: usize, canvas_height: usize) -> Option<Raster> {
    let bounds = path.bounds();
    let left = (bounds.left().floor().max(0.0) as usize).min(canvas_width);
    let right = (bounds.right().ceil().max(0.0) as usize).min(canvas_width);
    let top = (bounds.top().floor().max(0.0) as usize).min(canvas_height);
    let bottom = (bounds.bottom().ceil().max(0.0) as usize).min(canvas_height);
    if right <= left || bottom <= top {
        return None;
    }
    let (width, height) = (right - left, bottom - top);
    if let Some(rect) = axis_rect(path) {
        return Some(exact_rect(rect, left, top, width, height));
    }
    let mut raster = Raster { left, top, width, height, data: vec![0; width * height] };
    let edges = edges(path);
    if convex(path) && edges.len() >= 2 {
        walk_convex(&mut raster, edges);
    } else {
        let points: usize = path
            .segments()
            .map(|s| match s {
                PathSegment::MoveTo(_) | PathSegment::LineTo(_) => 1,
                PathSegment::QuadTo(_, _) => 2,
                PathSegment::CubicTo(_, _, _) => 3,
                PathSegment::Close => 0,
            })
            .sum();
        walk_edges(&mut raster, edges, rule, points > height * 2);
    }
    Some(raster)
}

// SkPathPriv::ComputeConvexity / Convexicator: control points participate in the
// direction test, not a sampled approximation of the curve. Only one contour.
fn convex(path: &Path) -> bool {
    let mut points: Vec<Point> = Vec::new();
    let mut finished = false;
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(p) => {
                if points.len() > 1 {
                    finished = true;
                } else {
                    points.clear();
                    points.push((p.x, p.y));
                }
            }
            PathSegment::Close => {
                finished = true;
            }
            _ if finished => return false,
            PathSegment::LineTo(p) => points.push((p.x, p.y)),
            PathSegment::QuadTo(c, p) => {
                points.push((c.x, c.y));
                points.push((p.x, p.y));
            }
            PathSegment::CubicTo(a, b, p) => {
                points.push((a.x, a.y));
                points.push((b.x, b.y));
                points.push((p.x, p.y));
            }
        }
    }
    if points.len() < 2 {
        return true;
    }
    let mut vectors = Vec::new();
    for i in 0..points.len() {
        let (a, b) = (points[i], points[(i + 1) % points.len()]);
        let v = (b.0 - a.0, b.1 - a.1);
        if !v.0.is_finite() || !v.1.is_finite() {
            return false;
        }
        if v != (0.0, 0.0) {
            vectors.push(v);
        }
    }
    if vectors.is_empty() {
        return true;
    }
    if points.len() > 3 {
        let (mut last_x, mut last_y, mut changes_x, mut changes_y) = (2, 2, 0, 0);
        for v in &vectors {
            let (sx, sy) = (i32::from(v.0 < 0.0), i32::from(v.1 < 0.0));
            changes_x += i32::from(sx != last_x);
            changes_y += i32::from(sy != last_y);
            if changes_x > 3 || changes_y > 3 {
                return false;
            }
            last_x = sx;
            last_y = sy;
        }
    }
    let mut last = vectors[0];
    let mut expected = 0;
    let mut reversals = 0;
    for current in vectors.iter().skip(1).chain(vectors.first()) {
        let cross = last.0 * current.1 - last.1 * current.0;
        if !cross.is_finite() {
            return false;
        }
        if cross == 0.0 {
            if last.0 * current.0 + last.1 * current.1 < 0.0 {
                reversals += 1;
                last = *current;
            }
            if reversals >= 3 {
                return false;
            }
        } else {
            let direction = if cross > 0.0 { 1 } else { -1 };
            if expected != 0 && expected != direction {
                return false;
            }
            expected = direction;
            last = *current;
        }
    }
    true
}

// Each group is one original analytic edge; subsequent entries are updateQuadratic
// or updateCubic chords. The convex walk advances those before consuming another
// original edge, exactly as the intrusive-list implementation does.
fn walk_convex(raster: &mut Raster, edges: Vec<Edge>) {
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, e) in edges.iter().enumerate() {
        if i == e.group {
            groups.push(Vec::new());
        }
        if let Some(g) = groups.last_mut() {
            g.push(i);
        }
    }
    groups.sort_by_key(|g| {
        let e = &edges[g[0]];
        (e.top.1, e.top.0, e.dx)
    });
    if groups.len() < 2 {
        return;
    }
    let stop = ((raster.top + raster.height) as i32) << 16;
    let mut side = [(0_usize, 0_usize), (1_usize, 0_usize)];
    let mut pending = 2;
    let mut y = edges[groups[0][0]].top.1.max(edges[groups[1][0]].top.1);
    let mut x = [edges[groups[0][0]].top.0, edges[groups[1][0]].top.0];
    let mut fy = [edges[groups[0][0]].top.1, edges[groups[1][0]].top.1];
    while y < stop {
        for k in 0..2 {
            while edges[groups[side[k].0][side[k].1]].bottom.1 <= y {
                if side[k].1 + 1 < groups[side[k].0].len() {
                    side[k].1 += 1;
                } else {
                    if pending >= groups.len() || edges[groups[pending][0]].top.1 >> 16 >= stop >> 16 {
                        return;
                    }
                    side[k] = (pending, 0);
                    pending += 1;
                }
                let e = &edges[groups[side[k].0][side[k].1]];
                x[k] = e.top.0;
                fy[k] = e.top.1;
            }
            let e = &edges[groups[side[k].0][side[k].1]];
            if y == fy[k] + ONE {
                x[k] = x[k].wrapping_add(e.dx);
            } else if y != fy[k] {
                x[k] = e.top.0.wrapping_add(fixed_mul(e.dx, y - e.top.1));
            }
            fy[k] = y;
        }
        let mut ids = [groups[side[0].0][side[0].1], groups[side[1].0][side[1].1]];
        if x[0] > x[1] || (x[0] == x[1] && edges[ids[0]].dx > edges[ids[1]].dx) {
            side.swap(0, 1);
            x.swap(0, 1);
            fy.swap(0, 1);
            ids.swap(0, 1);
        }
        let (le, re) = (&edges[ids[0]], &edges[ids[1]]);
        let mut bottom = le.bottom.1.min(re.bottom.1);
        let smooth = |k: usize, successor: usize| {
            let e = &edges[ids[k]];
            if side[k].1 + 1 < groups[side[k].0].len() {
                e.smooth
            } else {
                let n = &edges[groups[successor][0]];
                n.dx.saturating_sub(e.dx).unsigned_abs() <= ONE as u32 && n.bottom.1 - n.top.1 >= ONE
            }
        };
        if pending < groups.len() && edges[groups[pending][0]].top.1 < stop {
            let can_skip = if le.bottom.1.saturating_add(ONE) < re.bottom.1 {
                smooth(0, pending)
            } else if le.bottom.1 > re.bottom.1.saturating_add(ONE) {
                smooth(1, pending)
            } else if pending + 1 < groups.len() && edges[groups[pending + 1][0]].top.1 < stop {
                let (a, b) =
                    if edges[groups[pending + 1][0]].top.0 < edges[groups[pending][0]].top.0 { (pending + 1, pending) } else { (pending, pending + 1) };
                smooth(0, a) && smooth(1, b)
            } else {
                false
            };
            if can_skip {
                bottom = ceil_fixed(bottom);
            }
        }
        bottom = bottom.min(stop);
        // Keep the actual edge positions as scan state. Skia's edge builder clips
        // geometry before aaa_walk_convex_edges; our edges retain their original
        // positions and Row clips writes instead. Feeding a clipped x back into
        // the edge loses its slope intercept when it later re-enters the canvas.
        let (mut left, mut right) = (x[0], x[1]);
        if le.dx == 0 && re.dx == 0 {
            // The vertical fast path uses fixed_to_alpha, not 256-level trapezoids.
            while y < bottom {
                let next = ceil_fixed(y + 1).min(bottom);
                let h = next - y;
                if y >> 16 >= raster.top as i32 && right > left {
                    let from = left >> 16;
                    let to = ceil_int(right);
                    let mut row = Row { raster, y: y >> 16, full: fixed_alpha(h), no_real: false };
                    for px in from.max(row.raster.left as i32)..to.min((row.raster.left + row.raster.width) as i32) {
                        let width = right.min((px + 1) << 16) - left.max(px << 16);
                        row.pixel(px, fixed_alpha(fixed_mul(h, width)), false);
                    }
                }
                y = next;
            }
        } else {
            left += ONE >> 5;
            right += ONE >> 5;
            while y < bottom {
                let next = ceil_fixed(y + 1).min(bottom);
                let h = next - y;
                let nl = left.wrapping_add(fixed_mul(le.dx, h));
                let nr = right.wrapping_add(fixed_mul(re.dx, h));
                let mask = !((ONE >> 4) - 1);
                if y >> 16 >= raster.top as i32 {
                    trapezoid(
                        &mut Row { raster, y: y >> 16, full: fixed_alpha(h), no_real: false },
                        left & mask,
                        right & mask,
                        nl & mask,
                        nr & mask,
                        le.dy,
                        re.dy,
                    );
                }
                left = nl;
                right = nr;
                y = next;
            }
            left -= ONE >> 5;
            right -= ONE >> 5;
        }
        x = [left, right];
        fy = [y, y];
    }
}

const ONE: i32 = 1 << 16;
fn fixed_mul(a: i32, b: i32) -> i32 {
    ((i64::from(a) * i64::from(b)) >> 16) as i32
}
fn ceil_int(a: i32) -> i32 {
    ((i64::from(a) + 65535) >> 16) as i32
}
fn ceil_fixed(a: i32) -> i32 {
    ceil_int(a) << 16
}
fn trapezoid_alpha(a: i32, b: i32) -> u8 {
    (((i64::from(a) + i64::from(b)) / 2) >> 8) as u8
}
fn triangle_alpha(a: i32, b: i32) -> u8 {
    // partial_triangle_to_alpha: the & 0xff is intentional in the pinned source.
    (((i64::from(a >> 11) * i64::from(a >> 11) * i64::from(b >> 11)) >> 8) & 255) as u8
}
fn partial(alpha: u8, height: u8) -> u8 {
    ((u16::from(alpha) * u16::from(height)) >> 8) as u8
}
fn fixed_alpha(height: i32) -> u8 {
    ((255_i64 * i64::from(height) + 32768) >> 16) as u8
}

struct Row<'a> {
    raster: &'a mut Raster,
    y: i32,
    full: u8,
    no_real: bool,
}
impl Row<'_> {
    fn pixel(&mut self, x: i32, alpha: u8, replace: bool) {
        let (x, y) = (i64::from(x) - self.raster.left as i64, i64::from(self.y) - self.raster.top as i64);
        if x < 0 || y < 0 || x >= self.raster.width as i64 || y >= self.raster.height as i64 {
            return;
        }
        let value = &mut self.raster.data[y as usize * self.raster.width + x as usize];
        *value = if replace { alpha } else { value.saturating_add(alpha) };
    }
    fn single(&mut self, x: i32, alpha: u8) {
        let replace = self.full == 255 && !self.no_real;
        self.pixel(x, if replace { alpha } else { partial(alpha, self.full) }, replace);
    }
    fn pair(&mut self, x: i32, a: u8, b: u8) {
        self.pixel(x, a, false);
        self.pixel(x + 1, b, false);
    }
    fn full(&mut self, from: i32, to: i32) {
        for x in from.max(self.raster.left as i32)..to.min((self.raster.left + self.raster.width) as i32) {
            self.pixel(x, self.full, false);
        }
    }
}

// compute_alpha_above_line / compute_alpha_below_line. Their different endpoint
// formulas (exact multiply at one end, partial_triangle at the other) are deliberate.
fn line_alphas(l: i32, r: i32, dy: i32, full: u8, above: bool) -> Vec<u8> {
    let count = ceil_int(r).max(0) as usize;
    let mut out = vec![0; count];
    if count == 0 {
        return out;
    }
    if count == 1 {
        out[0] = partial(if above { ((2 * ONE - l - r) >> 9) as u8 } else { trapezoid_alpha(l, r) }, full);
    } else {
        let first = ONE - l;
        let last = r - ((count as i32 - 1) << 16);
        if above {
            let first_h = fixed_mul(first, dy);
            out[0] = (fixed_mul(first, first_h) >> 9) as u8;
            let mut alpha16 = first_h.saturating_add(dy >> 1);
            for v in out.iter_mut().take(count - 1).skip(1) {
                *v = (alpha16 >> 8) as u8;
                alpha16 = alpha16.saturating_add(dy);
            }
            out[count - 1] = full.wrapping_sub(triangle_alpha(last, dy));
        } else {
            let last_h = fixed_mul(last, dy);
            out[count - 1] = (fixed_mul(last, last_h) >> 9) as u8;
            let mut alpha16 = last_h.saturating_add(dy >> 1);
            for v in out.iter_mut().take(count - 1).skip(1).rev() {
                *v = (alpha16 >> 8) as u8;
                alpha16 = alpha16.saturating_add(dy);
            }
            out[0] = full.wrapping_sub(triangle_alpha(first, dy));
        }
    }
    out
}

fn aaa_trapezoid(row: &mut Row<'_>, ul: i32, ur: i32, ll: i32, lr: i32, ldy: i32, rdy: i32) {
    let (left, right) = (ul >> 16, ceil_int(lr));
    let len = right - left;
    if len <= 0 {
        return;
    }
    if len == 1 {
        row.single(left, trapezoid_alpha(ur - ul, lr - ll));
        return;
    }
    let mut alphas = vec![row.full; len as usize];
    let (u_l, l_l) = (ul >> 16, ceil_int(ll));
    if u_l + 2 == l_l {
        let first = (u_l << 16) + ONE - ul;
        let second = ll - ul - first;
        alphas[0] = alphas[0].saturating_sub(row.full.wrapping_sub(triangle_alpha(first, ldy)));
        alphas[1] = alphas[1].saturating_sub(triangle_alpha(second, ldy));
    } else {
        for (i, a) in line_alphas(ul - (u_l << 16), ll - (u_l << 16), ldy, row.full, false).into_iter().enumerate() {
            if let Some(value) = alphas.get_mut((u_l - left) as usize + i) {
                *value = value.saturating_sub(a);
            }
        }
    }
    let (u_r, l_r) = (ur >> 16, ceil_int(lr));
    if u_r + 2 == l_r {
        let first = (u_r << 16) + ONE - ur;
        let second = lr - ur - first;
        alphas[len as usize - 2] = alphas[len as usize - 2].saturating_sub(triangle_alpha(first, rdy));
        alphas[len as usize - 1] = alphas[len as usize - 1].saturating_sub(row.full.wrapping_sub(triangle_alpha(second, rdy)));
    } else {
        for (i, a) in line_alphas(ur - (u_r << 16), lr - (u_r << 16), rdy, row.full, true).into_iter().enumerate() {
            if let Some(value) = alphas.get_mut((u_r - left) as usize + i) {
                *value = value.saturating_sub(a);
            }
        }
    }
    for (i, a) in alphas.into_iter().enumerate() {
        row.pixel(left + i as i32, a, false);
    }
}

fn trapezoid(row: &mut Row<'_>, mut ul: i32, mut ur: i32, mut ll: i32, mut lr: i32, ldy: i32, rdy: i32) {
    if ul > ur {
        return;
    }
    if ll > lr {
        let l1 = ul.min(ll);
        let r1 = ul.max(ll);
        let l2 = ur.min(lr);
        let r2 = ur.max(lr);
        ll = ((i64::from(l1.max(l2)) + i64::from(r1.min(r2))) / 2) as i32;
        lr = ll;
    }
    if ul == ur && ll == lr {
        return;
    }
    if ul > ll {
        std::mem::swap(&mut ul, &mut ll);
    }
    if ur > lr {
        std::mem::swap(&mut ur, &mut lr);
    }
    let join_l = ceil_fixed(ll);
    let join_r = (ur >> 16) << 16;
    if join_l > join_r {
        aaa_trapezoid(row, ul, ur, ll, lr, ldy, rdy);
        return;
    }
    if ul < join_l {
        match ceil_int(join_l - ul) {
            1 => row.single(ul >> 16, trapezoid_alpha(join_l - ul, join_l - ll)),
            2 => {
                let first = join_l - ONE - ul;
                let second = ll - ul - first;
                row.pair(ul >> 16, triangle_alpha(first, ldy), row.full.wrapping_sub(triangle_alpha(second, ldy)));
            }
            _ => aaa_trapezoid(row, ul, join_l, ll, join_l, ldy, i32::MAX),
        }
    }
    if join_l < join_r {
        row.full(join_l >> 16, join_r >> 16);
    }
    if lr > join_r {
        match ceil_int(lr - join_r) {
            1 => row.single(join_r >> 16, trapezoid_alpha(ur - join_r, lr - join_r)),
            2 => {
                let first = join_r + ONE - ur;
                let second = lr - ur - first;
                row.pair(join_r >> 16, row.full.wrapping_sub(triangle_alpha(first, rdy)), triangle_alpha(second, rdy));
            }
            _ => aaa_trapezoid(row, join_r, ur, join_r, lr, i32::MAX, rdy),
        }
    }
}

impl Edge {
    fn keep_continuous(&mut self, start_x: i32) {
        let dx = start_x.wrapping_sub(self.top.0);
        if dx == 0 {
            return;
        }
        self.top.0 = start_x;
        let rise = (self.raw_bottom.1 - self.top.1) >> 10;
        if rise == 0 {
            return;
        }
        match self.step {
            CurveStep::Line => return,
            CurveStep::Quad { to } => {
                let slope_rise = (to.1 - self.top.1) >> 10;
                if slope_rise == 0 {
                    return;
                }
                self.dx = quick_div((to.0 - start_x) >> 10, slope_rise);
                self.raw_bottom.0 = to.0.wrapping_sub(fixed_mul(self.dx, to.1 - self.raw_bottom.1));
            }
            CurveStep::Cubic { last } => {
                if !last {
                    self.raw_bottom.0 = self.raw_bottom.0.wrapping_add(dx);
                }
                self.dx = ((i64::from((self.raw_bottom.0 - start_x) >> 10) << 16) / i64::from(rise)) as i32;
            }
        }
        let run = (self.raw_bottom.0 - start_x) >> 10;
        let abs_slope = (self.dx >> 10).abs();
        self.dy = if run == 0 || self.dx == 0 {
            i32::MAX
        } else if abs_slope < 1024 {
            quick_inverse(abs_slope)
        } else {
            quick_div(rise, run).abs()
        };
        self.bottom.0 = start_x.wrapping_add(fixed_mul(self.dx, self.bottom.1 - self.top.1));
    }
}

// aaa_walk_edges: the active edge array replaces the intrusive list, retaining its
// stable x order and quarter/half/full-row goY increments. Coverage is accumulated
// by winding intervals, not by folding an already integrated signed area.
fn insert_new_edge_after_cursor(active: &mut Vec<(usize, i32)>, edge: (usize, i32), cursor: usize) -> usize {
    // insert_new_edges keeps start=newEdge after each backward insertion. The
    // next edge must therefore search after that edge, preserving batch ties,
    // while the first new edge still precedes an existing equal-x edge.
    let at = cursor + active[cursor..].partition_point(|(_, x)| *x < edge.1);
    active.insert(at, edge);
    at
}

fn walk_edges(raster: &mut Raster, mut edges: Vec<Edge>, rule: FillRule, skip_intersect: bool) {
    let (clip_l, clip_r) = ((raster.left as i32) << 16, ((raster.left + raster.width) as i32) << 16);
    let stop = ((raster.top + raster.height) as i32) << 16;
    let mut final_x = vec![None; edges.len()];
    edges.sort_by_key(|e| (e.top.1, e.top.0, e.dx));
    let Some(first) = edges.first() else { return };
    let mut y = first.top.1.max((raster.top as i32) << 16);
    let mut cursor = 0;
    let mut active: Vec<(usize, i32)> = Vec::new();
    let mut first_scan = true;
    while y < stop {
        active.retain(|(i, _)| edges[*i].bottom.1 > y);
        let mut inserted = Vec::new();
        while cursor < edges.len() && edges[cursor].top.1 <= y {
            let e = &mut edges[cursor];
            if e.id > e.group {
                if let Some(previous_x) = final_x[e.id - 1] {
                    e.keep_continuous(previous_x);
                }
            }
            if e.bottom.1 > y {
                let placed = (cursor, e.top.0.wrapping_add(fixed_mul(e.dx, y - e.top.1)));
                if e.id == e.group {
                    inserted.push(placed);
                } else {
                    // A new chord is updateQuadratic/updateCubic of an existing
                    // edge, not insert_new_edges of a new source path segment.
                    active.push(placed);
                }
            }
            cursor += 1;
        }
        active.sort_by_key(|(_, x)| *x);
        // SkScan_AAAPath::insert_new_edges always checks newly inserted edges,
        // even when skipIntersect suppresses checks while advancing old edges.
        // In the backward-insertion branch it also checks the next edge before
        // that edge becomes active. This conservative lookahead affects strip
        // partitioning, hence integer alpha rounding, for multi-contour paths.
        let backward = inserted.first().is_some_and(|(_, x)| active.last().is_some_and(|(_, last)| last > x));
        let future = edges[cursor..].iter().find(|e| e.id == e.group).map(|e| (e.top.0, e.dx));
        let mut inserted_intersection = false;
        let mut insertion_cursor = 0;
        for (n, &(i, x)) in inserted.iter().enumerate() {
            let at = if backward {
                insert_new_edge_after_cursor(&mut active, (i, x), insertion_cursor)
            } else {
                let at = active.len();
                active.push((i, x));
                at
            };
            insertion_cursor = at + 1;
            if !first_scan {
                if at > 0 {
                    let (previous, px) = active[at - 1];
                    inserted_intersection |= i64::from(px) + i64::from(edges[previous].dx) > i64::from(x) + i64::from(edges[i].dx);
                }
                if backward {
                    let next_edge =
                        active.get(at + 1).map(|&(j, nx)| (nx, edges[j].dx)).or_else(|| inserted.get(n + 1).map(|&(j, nx)| (nx, edges[j].dx))).or(future);
                    if let Some((nx, ndx)) = next_edge {
                        inserted_intersection |= i64::from(x) + i64::from(edges[i].dx) > i64::from(nx) + i64::from(ndx);
                    }
                }
            }
        }
        first_scan = false;
        let mut next = ceil_fixed(y + 1).min(stop);
        if inserted_intersection {
            next = next.min(y + (ONE >> 2));
        }
        if let Some(e) = edges.get(cursor) {
            next = next.min(e.top.1);
        }
        for &(i, _) in &active {
            next = next.min(edges[i].bottom.1);
        }
        for pair in active.windows(2).filter(|_| !skip_intersect) {
            let (a, ax) = pair[0];
            let (b, bx) = pair[1];
            if i64::from(ax) + i64::from(edges[a].dx) > i64::from(bx) + i64::from(edges[b].dx) {
                next = next.min(y + (ONE >> 2));
            }
        }
        let mut shift = 0;
        if (next - y) & (ONE >> 2) != 0 {
            shift = 2;
            next = y + (ONE >> 2);
        } else if (next - y) & (ONE >> 1) != 0 {
            shift = 1;
        }
        let full = fixed_alpha(next - y);
        let mut winding: i32 = 0;
        let mut left: Option<(usize, i32, i32)> = None;
        let mut previous_right = clip_l >> 16;
        for pos in 0..active.len() {
            let (i, x) = active[pos];
            let e = &edges[i];
            let new_x = x.wrapping_add(e.dx >> shift);
            let was_inside = if rule == FillRule::EvenOdd { winding & 1 != 0 } else { winding != 0 };
            winding += if e.down { 1 } else { -1 };
            let inside = if rule == FillRule::EvenOdd { winding & 1 != 0 } else { winding != 0 };
            if inside && !was_inside {
                left = Some((i, x.max(clip_l), new_x.max(clip_l)));
            }
            if !inside && was_inside {
                if let Some((li, ul, ll)) = left.take() {
                    let ur = x.min(clip_r);
                    let lr = new_x.min(clip_r);
                    let next_close =
                        active.get(pos + 1).is_some_and(|&(ni, nx)| i64::from(x) + i64::from(ONE) >= i64::from(nx) - i64::from(edges[ni].dx).abs());
                    let no_real = full == 255 && (previous_right > ul >> 16 || previous_right > ll >> 16 || next_close);
                    trapezoid(&mut Row { raster, y: y >> 16, full, no_real }, ul, ur, ll, lr, edges[li].dy, e.dy);
                    previous_right = ceil_int(ur.max(new_x));
                }
            }
            active[pos].1 = new_x;
            if e.bottom.1 <= next {
                final_x[e.id] = Some(new_x);
            }
        }
        y = next;
    }
}

#[cfg(test)]
mod tests {
    use tiny_skia::PathBuilder;

    use super::*;

    fn polygon(points: &[(f32, f32)]) -> Path {
        let mut builder = PathBuilder::new();
        builder.move_to(points[0].0, points[0].1);
        for point in &points[1..] {
            builder.line_to(point.0, point.1);
        }
        builder.close();
        builder.finish().expect("a path")
    }

    fn at(raster: &Raster, x: usize, y: usize) -> u8 {
        raster.data[(y - raster.top) * raster.width + (x - raster.left)]
    }

    #[test]
    fn the_top_and_bottom_of_a_path_fall_on_quarter_pixels() {
        // 10.1 is held to 10.0 and 20.9 to 21.0: the first and the last row are covered whole, as Skia draws them.
        let path = polygon(&[(5.3, 10.1), (5.3, 20.9), (8.8, 20.9), (8.8, 10.1), (7.0, 10.1)]);
        let raster = coverage(&path, FillRule::Winding, 40, 40).expect("coverage");
        assert_eq!(at(&raster, 6, 10), 255);
        assert_eq!(at(&raster, 6, 20), 255);
    }

    #[test]
    fn a_rectangle_with_a_whole_pixel_across_leaves_the_exact_area_of_every_pixel() {
        // Recorded from Skia (`SkScan::AntiFillRect`): 5.3..8.8 by 10.1..20.9 is 229 in the full columns of its first row, 160 in
        // the corner and 178 along its left side.
        let path = polygon(&[(5.3, 10.1), (5.3, 20.9), (8.8, 20.9), (8.8, 10.1)]);
        let raster = coverage(&path, FillRule::Winding, 40, 40).expect("coverage");
        assert_eq!((at(&raster, 5, 10), at(&raster, 6, 10), at(&raster, 5, 15), at(&raster, 6, 15), at(&raster, 6, 20)), (160, 229, 178, 255, 229));
    }

    #[test]
    fn a_curve_is_drawn_as_the_chords_skia_cuts_it_into() {
        let mut builder = PathBuilder::new();
        builder.move_to(10.0, 30.0);
        builder.quad_to(20.0, 5.0, 30.0, 30.0);
        builder.close();
        let path = builder.finish().expect("a path");
        let raster = coverage(&path, FillRule::Winding, 40, 40).expect("coverage");
        // Inside the arch, outside it, and the area of the arch (two thirds of its chord times its rise of 12.5) to a few percent.
        assert_eq!(at(&raster, 20, 25), 255);
        assert_eq!(at(&raster, 11, 10), 0);
        let total: f32 = raster.data.iter().map(|value| f32::from(*value) / 255.0).sum();
        let exact = 2.0 / 3.0 * 20.0 * 12.5;
        assert!((total - exact).abs() / exact < 0.02, "area {total} against {exact}");
    }

    #[test]
    fn new_edges_sharing_a_vertex_keep_batch_order_before_existing_equal_x_edges() {
        let mut active = vec![(3, 5 * ONE), (0, 10 * ONE)];
        let mut cursor = 0;
        for edge in [(1, 5 * ONE), (2, 5 * ONE)] {
            cursor = insert_new_edge_after_cursor(&mut active, edge, cursor) + 1;
        }
        assert_eq!(active.iter().map(|&(id, _)| id).collect::<Vec<_>>(), [1, 2, 3, 0]);
        // The source's initial (upperY,x,dx) order is -1 then +1 at this shared
        // vertex. Reversing those ties invents a forward intersection (6 > 4).
        let slopes = [0, -ONE, ONE, ONE];
        let (left, lx) = active[0];
        let (right, rx) = active[1];
        assert!(lx + slopes[left] <= rx + slopes[right]);
    }

    #[test]
    fn a_new_contour_edge_checks_its_pending_successor_even_when_intersections_are_skipped() {
        // Original canvas 1.0.11 / pinned Skia: the Q in the Office PDF fixture.
        // Standalone bounded Node probe renders alpha 23 at (96,832); removing the
        // inner contour renders 24. The inner contour causes insert_new_edges to
        // look forward to a pending edge and split the strip at y=832.5.
        let mut builder = PathBuilder::new();
        builder.move_to(0.72998047, 0.34716797);
        builder.quad_to(0.72998047, 0.27441406, 0.71118164, 0.21411133);
        builder.quad_to(0.69238281, 0.15380859, 0.65698242, 0.10839844);
        builder.quad_to(0.62158203, 0.062988281, 0.57006836, 0.034423828);
        builder.quad_to(0.51855469, 0.005859375, 0.453125, -0.0029296875);
        builder.quad_to(0.46337891, -0.034179688, 0.47631836, -0.056152344);
        builder.quad_to(0.48925781, -0.078125, 0.50585938, -0.092041016);
        builder.quad_to(0.52246094, -0.10595703, 0.54272461, -0.11254883);
        builder.quad_to(0.56298828, -0.11914062, 0.58789062, -0.11914062);
        builder.quad_to(0.6015625, -0.11914062, 0.6171875, -0.1171875);
        builder.quad_to(0.6328125, -0.11523438, 0.64404297, -0.11279297);
        builder.line_to(0.64404297, -0.17822266);
        builder.quad_to(0.62548828, -0.18261719, 0.60327148, -0.18579102);
        builder.quad_to(0.58105469, -0.18896484, 0.55712891, -0.18896484);
        builder.quad_to(0.51513672, -0.18896484, 0.48388672, -0.17651367);
        builder.quad_to(0.45263672, -0.1640625, 0.42895508, -0.14086914);
        builder.quad_to(0.40527344, -0.11767578, 0.38818359, -0.083984375);
        builder.quad_to(0.37109375, -0.050292969, 0.35791016, -0.0078125);
        builder.quad_to(0.28076172, -0.00390625, 0.22241211, 0.024169922);
        builder.quad_to(0.1640625, 0.052246094, 0.12524414, 0.099365234);
        builder.quad_to(0.086425781, 0.14648438, 0.066894531, 0.2097168);
        builder.quad_to(0.047363281, 0.27294922, 0.047363281, 0.34716797);
        builder.quad_to(0.047363281, 0.42773438, 0.069824219, 0.49267578);
        builder.quad_to(0.092285156, 0.55761719, 0.13574219, 0.60327148);
        builder.quad_to(0.17919922, 0.64892578, 0.24291992, 0.67358398);
        builder.quad_to(0.30664062, 0.69824219, 0.38916016, 0.69824219);
        builder.quad_to(0.47119141, 0.69824219, 0.53491211, 0.67333984);
        builder.quad_to(0.59863281, 0.6484375, 0.6418457, 0.60253906);
        builder.quad_to(0.68505859, 0.55664062, 0.70751953, 0.49169922);
        builder.quad_to(0.72998047, 0.42675781, 0.72998047, 0.34716797);
        builder.line_to(0.72998047, 0.34716797);
        builder.move_to(0.63476562, 0.34716797);
        builder.quad_to(0.63476562, 0.40917969, 0.61889648, 0.45996094);
        builder.quad_to(0.60302734, 0.51074219, 0.57202148, 0.546875);
        builder.quad_to(0.54101562, 0.58300781, 0.49511719, 0.60253906);
        builder.quad_to(0.44921875, 0.62207031, 0.38916016, 0.62207031);
        builder.quad_to(0.32763672, 0.62207031, 0.28125, 0.60253906);
        builder.quad_to(0.23486328, 0.58300781, 0.20385742, 0.546875);
        builder.quad_to(0.17285156, 0.51074219, 0.1574707, 0.45996094);
        builder.quad_to(0.14208984, 0.40917969, 0.14208984, 0.34716797);
        builder.quad_to(0.14208984, 0.28515625, 0.15795898, 0.23364258);
        builder.quad_to(0.17382812, 0.18212891, 0.20483398, 0.14477539);
        builder.quad_to(0.23583984, 0.10742188, 0.28198242, 0.086669922);
        builder.quad_to(0.328125, 0.065917969, 0.38818359, 0.065917969);
        builder.quad_to(0.45263672, 0.065917969, 0.49926758, 0.086914062);
        builder.quad_to(0.54589844, 0.10791016, 0.57592773, 0.14526367);
        builder.quad_to(0.60595703, 0.18261719, 0.62036133, 0.234375);
        builder.quad_to(0.63476562, 0.28613281, 0.63476562, 0.34716797);
        builder.close();
        let path = builder
            .finish()
            .expect("Q path")
            .transform(tiny_skia::Transform::from_row(17.201988, 0.0, 0.0, -17.201988, 83.87689, 840.62897))
            .expect("device Q");
        let raster = coverage(&path, FillRule::Winding, 640, 906).expect("Q coverage");
        assert_eq!(at(&raster, 96, 832), 23);
    }

    #[test]
    fn quick_div_uses_the_pinned_reciprocal_range() {
        assert_eq!(quick_div(1024, 63), 1_065_216);
        assert_eq!(quick_div(-1024, 63), -1_065_216);
        assert_eq!(quick_div(4095, 63), (4095 * ((1 << 22) / 63)) >> 6);
        assert_eq!(quick_div(4096, 63), ((4096_i64 << 16) / 63) as i32);
        assert_eq!(quick_div(1024, 1024), 1 << 16);
    }

    #[test]
    fn an_edge_reentering_the_canvas_keeps_its_original_intercept() {
        // The blue rectangle of PDF group-matrix-bbox at scale 2 extends two
        // pixels past its group's canvas, then returns along the lower diagonal.
        let path = polygon(&[(68.0, 56.0), (140.0, 24.0), (172.0, 96.0), (100.0, 128.0)]);
        let whole = coverage(&path, FillRule::Winding, 200, 180).expect("whole");
        let clipped = coverage(&path, FillRule::Winding, 170, 180).expect("clipped");
        for y in clipped.top..clipped.top + clipped.height {
            for x in clipped.left..clipped.left + clipped.width {
                assert_eq!(at(&clipped, x, y), at(&whole, x, y), "cropping changed ({x}, {y})");
            }
        }
    }

    #[test]
    fn even_odd_leaves_the_inner_square_empty() {
        let mut builder = PathBuilder::new();
        for (x0, y0, x1, y1) in [(5.0_f32, 5.0_f32, 25.0_f32, 25.0_f32), (10.0, 10.0, 20.0, 20.0)] {
            builder.move_to(x0, y0);
            builder.line_to(x1, y0);
            builder.line_to(x1, y1);
            builder.line_to(x0, y1);
            builder.close();
        }
        let path = builder.finish().expect("a path");
        let raster = coverage(&path, FillRule::EvenOdd, 40, 40).expect("coverage");
        assert_eq!(at(&raster, 7, 15), 255);
        assert_eq!(at(&raster, 15, 15), 0);
    }

    #[test]
    fn a_vertical_edge_leaves_the_exact_share_of_its_pixel_held_to_a_256th() {
        // Original canvas 1.0.11: alpha 230 (white-background RGB 25), reproduced by
        // tests/oracles/analytic-vertical.mjs and retained in analytic-vertical.json.
        let path = polygon(&[(10.1, 5.0), (10.1, 25.0), (30.0, 25.0), (30.0, 5.0), (20.0, 4.5)]);
        let raster = coverage(&path, FillRule::Winding, 40, 40).expect("coverage");
        assert_eq!(at(&raster, 10, 15), 230);
        assert_eq!(at(&raster, 11, 15), 255);
    }
}
