//! The path half of the canvas: `Path2D` and the current path of a context.
//!
//! A [`Path2D`] keeps its points in the space they were added in, after the transform it carries at that moment: a
//! plain `Path2D` carries the identity, the current path of a [`Canvas`](super::Canvas) carries the context's
//! transform and the canvas sets it before every call, which is the canvas rule that a point is mapped when it is
//! added and not when the path is drawn. Arcs and ellipses are cut into cubic segments of at most a quarter turn in the
//! space the arguments are given in and the segments are mapped, so a skewed or scaled transform bends them as it
//! should.

use std::f32::consts::FRAC_PI_2;
use std::f32::consts::PI;
use std::f32::consts::TAU;

use tiny_skia::Path;
use tiny_skia::PathBuilder;
use tiny_skia::Point;
use tiny_skia::Transform;

use crate::RasterError;

/// A canvas path (`Path2D`).
#[derive(Clone, Debug)]
pub struct Path2D {
    builder: PathBuilder,
    transform: Transform,
}

impl Default for Path2D {
    fn default() -> Self {
        Self { builder: PathBuilder::new(), transform: Transform::identity() }
    }
}

pub(super) fn finite(values: &[f32]) -> bool {
    values.iter().all(|value| value.is_finite())
}

impl Path2D {
    pub fn new() -> Self {
        Self::default()
    }

    /// The transform applied to every point added from now on.
    pub(crate) fn set_transform(&mut self, transform: Transform) {
        self.transform = transform;
    }

    pub fn is_empty(&self) -> bool {
        self.builder.is_empty()
    }

    /// Forgets every sub-path (`beginPath`).
    pub(crate) fn clear(&mut self) {
        self.builder.clear();
    }

    /// The finished path in the space the points were added in, `None` while it holds nothing to draw.
    pub fn to_path(&self) -> Option<Path> {
        self.builder.clone().finish()
    }

    fn map(&self, x: f32, y: f32) -> Point {
        let mut point = Point::from_xy(x, y);
        self.transform.map_point(&mut point);
        point
    }

    /// The last point in the space of the arguments, if the path has one.
    fn current(&self) -> Option<(f32, f32)> {
        let mut point = self.builder.last_point()?;
        self.transform.invert()?.map_point(&mut point);
        Some((point.x, point.y))
    }

    /// An empty path starts a sub-path at `(x, y)`; a curve then continues from it.
    fn ensure_subpath(&mut self, x: f32, y: f32) {
        if self.builder.is_empty() {
            let point = self.map(x, y);
            self.builder.move_to(point.x, point.y);
        }
    }

    pub fn move_to(&mut self, x: f32, y: f32) {
        if !finite(&[x, y]) {
            return;
        }
        let point = self.map(x, y);
        self.builder.move_to(point.x, point.y);
    }

    /// A line from the last point; on an empty path it only starts the sub-path. After `closePath` the builder starts
    /// the new sub-path at the start of the closed one, as the canvas does.
    pub fn line_to(&mut self, x: f32, y: f32) {
        if !finite(&[x, y]) {
            return;
        }
        if self.builder.is_empty() {
            self.move_to(x, y);
            return;
        }
        let point = self.map(x, y);
        self.builder.line_to(point.x, point.y);
    }

    pub fn quadratic_curve_to(&mut self, cpx: f32, cpy: f32, x: f32, y: f32) {
        if !finite(&[cpx, cpy, x, y]) {
            return;
        }
        self.ensure_subpath(cpx, cpy);
        let (control, end) = (self.map(cpx, cpy), self.map(x, y));
        self.builder.quad_to(control.x, control.y, end.x, end.y);
    }

    pub fn bezier_curve_to(&mut self, cp1x: f32, cp1y: f32, cp2x: f32, cp2y: f32, x: f32, y: f32) {
        if !finite(&[cp1x, cp1y, cp2x, cp2y, x, y]) {
            return;
        }
        self.ensure_subpath(cp1x, cp1y);
        let (first, second, end) = (self.map(cp1x, cp1y), self.map(cp2x, cp2y), self.map(x, y));
        self.builder.cubic_to(first.x, first.y, second.x, second.y, end.x, end.y);
    }

    pub fn close_path(&mut self) {
        if !self.builder.is_empty() {
            self.builder.close();
        }
    }

    /// `rect(x, y, w, h)`: a closed sub-path, and the next sub-path starts at `(x, y)`.
    pub fn rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        if !finite(&[x, y, width, height]) {
            return;
        }
        self.move_to(x, y);
        self.line_to(x + width, y);
        self.line_to(x + width, y + height);
        self.line_to(x, y + height);
        self.close_path();
        self.move_to(x, y);
    }

    /// `roundRect(x, y, w, h, radii)` with one to four radii (top-left, top-right, bottom-right, bottom-left, the
    /// canvas order for four; two give the diagonals, three the sides). A negative radius is an error.
    pub fn round_rect(&mut self, x: f32, y: f32, width: f32, height: f32, radii: &[f32]) -> Result<(), RasterError> {
        let mut corners = match radii {
            [all] => [*all; 4],
            [diagonal, other] => [*diagonal, *other, *diagonal, *other],
            [top_left, diagonal, bottom_right] => [*top_left, *diagonal, *bottom_right, *diagonal],
            [top_left, top_right, bottom_right, bottom_left] => [*top_left, *top_right, *bottom_right, *bottom_left],
            _ => return Err(RasterError::new("roundRect takes between one and four radii")),
        };
        if !finite(&[x, y, width, height]) || !finite(radii) {
            return Ok(());
        }
        if corners.iter().any(|radius| *radius < 0.0) {
            return Err(RasterError::new("a roundRect radius is negative"));
        }
        let (left, right) = if width < 0.0 { (x + width, x) } else { (x, x + width) };
        let (top, bottom) = if height < 0.0 { (y + height, y) } else { (y, y + height) };
        let (width, height) = (right - left, bottom - top);
        // The radii shrink together until two neighbours fit on every side.
        let fit = [
            width / (corners[0] + corners[1]),
            height / (corners[1] + corners[2]),
            width / (corners[2] + corners[3]),
            height / (corners[3] + corners[0]),
        ]
        .into_iter()
        .filter(|ratio| ratio.is_finite())
        .fold(1.0_f32, f32::min);
        if fit < 1.0 {
            for radius in &mut corners {
                *radius *= fit;
            }
        }
        let [top_left, top_right, bottom_right, bottom_left] = corners;
        self.move_to(left + top_left, top);
        self.line_to(right - top_right, top);
        self.corner(right - top_right, top + top_right, top_right, -FRAC_PI_2);
        self.line_to(right, bottom - bottom_right);
        self.corner(right - bottom_right, bottom - bottom_right, bottom_right, 0.0);
        self.line_to(left + bottom_left, bottom);
        self.corner(left + bottom_left, bottom - bottom_left, bottom_left, FRAC_PI_2);
        self.line_to(left, top + top_left);
        self.corner(left + top_left, top + top_left, top_left, PI);
        self.close_path();
        self.move_to(left, top);
        Ok(())
    }

    /// A quarter circle of `radius` about `(cx, cy)` from `start` (radians), as the end of a rounded corner.
    fn corner(&mut self, cx: f32, cy: f32, radius: f32, start: f32) {
        if radius > 0.0 {
            // The corner starts and ends on an axis: the points and the tangents come from exact unit vectors, so a
            // rounded rectangle's outline touches its box exactly instead of by the rounding of sin and cos.
            const AXES: [(f32, f32); 4] = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)];
            let quarter = (start / FRAC_PI_2).round() as i32;
            let (c0, s0) = AXES[quarter.rem_euclid(4) as usize];
            let (c1, s1) = AXES[(quarter + 1).rem_euclid(4) as usize];
            let k = 4.0 / 3.0 * (FRAC_PI_2 / 4.0).tan();
            self.bezier_curve_to(
                cx + radius * (c0 - k * s0),
                cy + radius * (s0 + k * c0),
                cx + radius * (c1 + k * s1),
                cy + radius * (s1 - k * c1),
                cx + radius * c1,
                cy + radius * s1,
            );
        }
    }

    /// Cubic segments for the elliptical arc about `(cx, cy)` from `start` sweeping `sweep` radians; the caller has
    /// joined the current point to the arc's first point.
    #[allow(clippy::too_many_arguments)]
    fn arc_segments(&mut self, cx: f32, cy: f32, rx: f32, ry: f32, rotation: f32, start: f32, sweep: f32) {
        let pieces = ((sweep.abs() / FRAC_PI_2).ceil() as usize).max(1);
        let step = sweep / pieces as f32;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let (sin_r, cos_r) = rotation.sin_cos();
        // The point and the tangent of the ellipse at `angle`, rotated and moved.
        let at = |angle: f32| -> (f32, f32, f32, f32) {
            let (sin, cos) = angle.sin_cos();
            let (px, py) = (rx * cos, ry * sin);
            let (tx, ty) = (-rx * sin, ry * cos);
            (cx + px * cos_r - py * sin_r, cy + px * sin_r + py * cos_r, tx * cos_r - ty * sin_r, tx * sin_r + ty * cos_r)
        };
        let mut angle = start;
        let mut from = at(angle);
        for _ in 0..pieces {
            angle += step;
            let to = at(angle);
            self.bezier_curve_to(from.0 + k * from.2, from.1 + k * from.3, to.0 - k * to.2, to.1 - k * to.3, to.0, to.1);
            from = to;
        }
    }

    /// `ellipse(x, y, rx, ry, rotation, start, end, counterclockwise)`.
    #[allow(clippy::too_many_arguments)]
    pub fn ellipse(
        &mut self,
        x: f32,
        y: f32,
        rx: f32,
        ry: f32,
        rotation: f32,
        start: f32,
        end: f32,
        counterclockwise: bool,
    ) -> Result<(), RasterError> {
        if rx < 0.0 || ry < 0.0 {
            return Err(RasterError::new("the radius of an ellipse is negative"));
        }
        if !finite(&[x, y, rx, ry, rotation, start, end]) {
            return Ok(());
        }
        let sweep = arc_sweep(start, end, counterclockwise);
        let (sin_r, cos_r) = rotation.sin_cos();
        let (sin_s, cos_s) = start.sin_cos();
        let (px, py) = (rx * cos_s, ry * sin_s);
        self.line_to(x + px * cos_r - py * sin_r, y + px * sin_r + py * cos_r);
        if sweep != 0.0 {
            self.arc_segments(x, y, rx, ry, rotation, start, sweep);
        }
        Ok(())
    }

    /// `arc(x, y, radius, start, end, counterclockwise)`.
    pub fn arc(&mut self, x: f32, y: f32, radius: f32, start: f32, end: f32, counterclockwise: bool) -> Result<(), RasterError> {
        if radius < 0.0 {
            return Err(RasterError::new("the radius of an arc is negative"));
        }
        self.ellipse(x, y, radius, radius, 0.0, start, end, counterclockwise)
    }

    /// `arcTo(x1, y1, x2, y2, radius)`: the arc of `radius` tangent to the lines from the current point to `(x1, y1)`
    /// and from `(x1, y1)` to `(x2, y2)`.
    pub fn arc_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, radius: f32) -> Result<(), RasterError> {
        if radius < 0.0 {
            return Err(RasterError::new("the radius of an arcTo is negative"));
        }
        if !finite(&[x1, y1, x2, y2, radius]) {
            return Ok(());
        }
        let Some((x0, y0)) = self.current() else {
            self.move_to(x1, y1);
            return Ok(());
        };
        let (d0x, d0y) = (x0 - x1, y0 - y1);
        let (d1x, d1y) = (x2 - x1, y2 - y1);
        let (len0, len1) = (d0x.hypot(d0y), d1x.hypot(d1y));
        let cross = d0x * d1y - d0y * d1x;
        if len0 == 0.0 || len1 == 0.0 || cross.abs() < 1e-6 * len0 * len1 || radius == 0.0 {
            self.line_to(x1, y1);
            return Ok(());
        }
        let cos_angle = (d0x * d1x + d0y * d1y) / (len0 * len1);
        let half = cos_angle.clamp(-1.0, 1.0).acos() / 2.0;
        let tangent = radius / half.tan();
        let (u0x, u0y) = (d0x / len0, d0y / len0);
        let (u1x, u1y) = (d1x / len1, d1y / len1);
        let (t0x, t0y) = (x1 + u0x * tangent, y1 + u0y * tangent);
        let (t1x, t1y) = (x1 + u1x * tangent, y1 + u1y * tangent);
        // The centre lies on the bisector, at `radius` from both lines, on the side the corner opens to.
        let (bx, by) = (u0x + u1x, u0y + u1y);
        let blen = bx.hypot(by);
        let distance = radius / half.sin();
        let (cx, cy) = (x1 + bx / blen * distance, y1 + by / blen * distance);
        let start = (t0y - cy).atan2(t0x - cx);
        let end = (t1y - cy).atan2(t1x - cx);
        self.line_to(t0x, t0y);
        let sweep = arc_sweep(start, end, cross > 0.0);
        self.arc_segments(cx, cy, radius, radius, 0.0, start, sweep);
        Ok(())
    }

    /// `addPath(other, transform)`: the sub-paths of `other` with `transform` applied, then this path's own transform.
    pub fn add_path(&mut self, other: &Path2D, transform: Transform) {
        let Some(path) = other.to_path() else { return };
        let Some(path) = path.transform(transform.post_concat(self.transform)) else { return };
        self.builder.push_path(&path);
    }
}

/// The sweep of an arc from `start` to `end` as the canvas draws it: a full turn at most, in the requested direction.
fn arc_sweep(start: f32, end: f32, counterclockwise: bool) -> f32 {
    let delta = end - start;
    if counterclockwise {
        if -delta >= TAU { -TAU } else { -(-delta).rem_euclid(TAU) }
    } else if delta >= TAU {
        TAU
    } else {
        delta.rem_euclid(TAU)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(path: &Path2D) -> (f32, f32, f32, f32) {
        let b = path.to_path().expect("a path").bounds();
        (b.left(), b.top(), b.right(), b.bottom())
    }

    #[test]
    fn a_line_without_a_subpath_starts_one() {
        let mut path = Path2D::new();
        path.line_to(3.0, 4.0);
        assert!(path.to_path().is_none(), "a lone move draws nothing");
        path.line_to(7.0, 4.0);
        assert_eq!(bounds(&path), (3.0, 4.0, 7.0, 4.0));
    }

    #[test]
    fn a_rect_is_closed_and_the_next_subpath_starts_at_its_corner() {
        let mut path = Path2D::new();
        path.rect(2.0, 3.0, 4.0, 5.0);
        assert_eq!(bounds(&path), (2.0, 3.0, 6.0, 8.0));
        path.line_to(20.0, 30.0);
        assert_eq!(bounds(&path), (2.0, 3.0, 20.0, 30.0));
    }

    #[test]
    fn a_full_circle_covers_its_bounding_square() {
        let mut path = Path2D::new();
        path.arc(10.0, 10.0, 5.0, 0.0, TAU, false).unwrap();
        let (left, top, right, bottom) = bounds(&path);
        for (got, want) in [(left, 5.0), (top, 5.0), (right, 15.0), (bottom, 15.0)] {
            assert!((got - want).abs() < 0.05, "{got} vs {want}");
        }
    }

    #[test]
    fn a_negative_radius_is_an_error_and_a_non_finite_argument_is_ignored() {
        let mut path = Path2D::new();
        assert!(path.arc(0.0, 0.0, -1.0, 0.0, 1.0, false).is_err());
        assert!(path.arc_to(0.0, 0.0, 1.0, 1.0, -1.0).is_err());
        path.move_to(f32::NAN, 1.0);
        path.line_to(1.0, f32::INFINITY);
        assert!(path.is_empty());
    }

    #[test]
    fn the_transform_is_applied_when_the_point_is_added() {
        let mut path = Path2D::new();
        path.set_transform(Transform::from_translate(10.0, 0.0));
        path.move_to(0.0, 0.0);
        path.set_transform(Transform::identity());
        path.line_to(1.0, 1.0);
        assert_eq!(bounds(&path), (1.0, 0.0, 10.0, 1.0));
    }

    #[test]
    fn sweeps_follow_the_canvas_rules() {
        assert_eq!(arc_sweep(0.0, 10.0, false), TAU);
        assert_eq!(arc_sweep(0.0, -10.0, true), -TAU);
        assert!((arc_sweep(0.0, -FRAC_PI_2, false) - 3.0 * FRAC_PI_2).abs() < 1e-5);
        assert!((arc_sweep(0.0, FRAC_PI_2, true) + 3.0 * FRAC_PI_2).abs() < 1e-5);
        assert_eq!(arc_sweep(1.0, 1.0, false), 0.0);
    }

    #[test]
    fn arc_to_rounds_a_right_angle_corner() {
        let mut path = Path2D::new();
        path.move_to(0.0, 0.0);
        path.arc_to(10.0, 0.0, 10.0, 10.0, 2.0).unwrap();
        let (left, _, right, bottom) = bounds(&path);
        assert_eq!(left, 0.0);
        assert!((right - 10.0).abs() < 1e-4);
        assert!((bottom - 2.0).abs() < 1e-3, "the arc ends 2 below the corner: {bottom}");
    }

    #[test]
    fn a_round_rect_with_too_large_radii_shrinks_them_to_fit() {
        let mut path = Path2D::new();
        path.round_rect(0.0, 0.0, 10.0, 10.0, &[50.0]).unwrap();
        assert_eq!(bounds(&path), (0.0, 0.0, 10.0, 10.0));
        assert!(path.round_rect(0.0, 0.0, 1.0, 1.0, &[-1.0]).is_err());
        assert!(path.round_rect(0.0, 0.0, 1.0, 1.0, &[]).is_err());
    }
}
