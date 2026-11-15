//! Skia's analytic anti-aliasing of a path fill (`SkScan_AAAPath.cpp`, which `@napi-rs/canvas` draws every path with): the
//! coverage of a pixel is the exact area the path leaves in it, not the 4x4 supersampling of the scan converter tiny-skia
//! ports (`SkScan_AntiPath.cpp`). The path is cut into the line edges Skia builds from it (`SkEdgeBuilder`: a quad or a cubic
//! is chopped where its y is not monotonic, then drawn as `1 << shift` chords, `shift` chosen as
//! `SkQuadraticEdge::setQuadraticWithoutUpdate` and `SkCubicEdge::setCubicWithoutUpdate` choose it from the curve's distance
//! from its chord, the points held to 1/256 of a pixel as `SkAnalyticEdge::setLine` holds them), and the area each line leaves
//! to its right is summed along every row; the winding rule turns the sum into a coverage.

use tiny_skia::{FillRule, Path, PathSegment};

use super::glyph::{Raster, add_line};

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
struct Edge {
    top: Point,
    bottom: Point,
    down: bool,
}

/// `SkAnalyticEdge::updateLine`: an edge from `a` to `b` (16.16 pixels). Its slope is the quotient of the two differences held
/// to 1/64 of a pixel (`quick_div` of `SkFixedToFDot6`), and the edge runs down its rows by that slope from its top point, so
/// the x it ends at is the top x plus the slope times the height, not the x it was asked to end at.
fn put(edges: &mut Vec<Edge>, a: (i32, i32), b: (i32, i32), down: bool) {
    let (top, bottom, down) = if a.1 <= b.1 { (a, b, down) } else { (b, a, !down) };
    let rise = (bottom.1 - top.1) >> 10;
    if rise == 0 {
        return;
    }
    let slope = ((i64::from((bottom.0 - top.0) >> 10) << 16) / i64::from(rise)) as i32;
    let end_x = top.0.wrapping_add(((i64::from(slope) * i64::from(bottom.1 - top.1)) >> 16) as i32);
    edges.push(Edge { top: (fixed_to_f32(top.0), fixed_to_f32(top.1)), bottom: (fixed_to_f32(end_x), fixed_to_f32(bottom.1)), down });
}

/// `SkAnalyticEdge::setLine`: x truncated to 1/256 of a pixel, y held to a quarter; a line that is flat after that is no edge.
fn line(edges: &mut Vec<Edge>, a: Point, b: Point) {
    let fixed = |point: Point| (fdot(point.0) << 8, snap_fixed(fdot(point.1) << 8));
    put(edges, fixed(a), fixed(b), true);
}

/// `SnapY` on a 16.16 value: a quarter of a pixel, rounded half up.
fn snap_fixed(y: i32) -> i32 {
    ((((y as u32).wrapping_add(0x2000)) >> 14) << 14) as i32
}

fn fixed_to_f32(value: i32) -> f32 {
    value as f32 / 65536.0
}

/// `SkQuadraticEdge::setQuadraticWithoutUpdate` and `SkAnalyticQuadraticEdge::updateQuadratic`: one monotonic piece of a quad
/// walked from the top down by forward differencing in 16.16 (the start y snapped to a quarter pixel before the walk, as
/// `setQuadratic` does), each step's y snapped to a quarter pixel; a step of two pixels or more is snapped to a whole pixel with
/// its x moved along the chord. A step that ends on the y the last chord ended on makes no chord; the next one starts from
/// where the last ended.
fn quad_edges(edges: &mut Vec<Edge>, piece: [Point; 3]) {
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
        let (new_x, new_y, new_snapped_x, new_snapped_y);
        if count > 0 {
            new_x = old_x.wrapping_add(cdx >> (shift - 1));
            new_y = old_y.wrapping_add(cdy >> (shift - 1));
            if (cdy >> (shift - 1)).abs() >= 2 << 16 {
                let rise = (new_y - snapped_y) >> 10;
                let slope = if rise != 0 { ((i64::from((new_x - snapped_x) >> 10) << 16) / i64::from(rise)) as i32 } else { 0 };
                new_snapped_y = last_y.min((new_y.wrapping_add(0x8000)) & !0xFFFF);
                new_snapped_x = new_x.wrapping_sub(((i64::from(slope) * i64::from(new_y - new_snapped_y)) >> 16) as i32);
            } else {
                new_snapped_y = last_y.min(snap_fixed(new_y));
                new_snapped_x = new_x;
            }
            cdx = cdx.wrapping_add(ddx);
            cdy = cdy.wrapping_add(ddy);
        } else {
            new_x = last_x;
            new_y = last_y;
            new_snapped_y = new_y;
            new_snapped_x = new_x;
        }
        if (new_snapped_y - snapped_y) >> 10 != 0 {
            put(edges, (snapped_x, snapped_y), (new_snapped_x, new_snapped_y), down);
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
    let mut down = true;
    let mut c = [
        fdot(piece[0].0),
        fdot(piece[0].1),
        fdot(piece[1].0),
        fdot(piece[1].1),
        fdot(piece[2].0),
        fdot(piece[2].1),
        fdot(piece[3].0),
        fdot(piece[3].1),
    ];
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

/// The coverage of `path` (device pixels) over a canvas of `canvas_width` x `canvas_height`: the exact area of each pixel, in
/// 256 levels, folded by the winding `rule`; `None` when the path touches no pixel.
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
    let stride = width + 2;
    let mut area = vec![0.0_f32; stride * height];
    let (ox, oy) = (left as f32, top as f32);
    for edge in edges(path) {
        let (a, b) = ((edge.top.0 - ox, edge.top.1 - oy), (edge.bottom.0 - ox, edge.bottom.1 - oy));
        if edge.down {
            add_line(&mut area, stride, width, height, a, b);
        } else {
            add_line(&mut area, stride, width, height, b, a);
        }
    }
    let mut data = vec![0_u8; width * height];
    for row in 0..height {
        let mut sum = 0.0_f32;
        for column in 0..width {
            sum += area[row * stride + column];
            let level = match rule {
                FillRule::Winding => sum.abs().min(1.0),
                FillRule::EvenOdd => {
                    let folded = sum.abs() % 2.0;
                    if folded > 1.0 { 2.0 - folded } else { folded }
                }
            };
            data[row * width + column] = alpha(level);
        }
    }
    Some(Raster { left, top, width, height, data })
}

fn alpha(level: f32) -> u8 {
    ((level * 256.0 + 0.001) as u32).min(255) as u8
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
    fn a_vertical_edge_leaves_the_exact_share_of_its_pixel_held_to_a_256th() {
        // Recorded from Skia: a path (not a rectangle) with a vertical edge at 10.1 leaves 231 of 255 in its column.
        let path = polygon(&[(10.1, 5.0), (10.1, 25.0), (30.0, 25.0), (30.0, 5.0), (20.0, 4.5)]);
        let raster = coverage(&path, FillRule::Winding, 40, 40).expect("coverage");
        assert_eq!(at(&raster, 10, 15), 231);
        assert_eq!(at(&raster, 11, 15), 255);
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
}
