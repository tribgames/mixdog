//! The state the operator-list pass keeps while it reads a content stream (pdf.js `EvalState` and `StateManager`)
//! and the matrix and bounding-box helpers of pdf.js's `Util`. Single-precision storage follows the typed arrays
//! pdf.js keeps: a path's coordinates and its bounding box are `Float32Array`s.

use std::sync::Arc;

use crate::color::ColorSpace;

use super::FontHandle;

/// A transform `[a, b, c, d, e, f]`.
pub type Matrix = [f64; 6];

pub const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `F32_BBOX_INIT` / `BBOX_INIT`: an empty box.
pub const BBOX_INIT: [f32; 4] = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];

/// `Util.transform`: `m1` applied after `m2`.
pub fn transform(m1: &[f64], m2: &[f64]) -> Matrix {
    [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]
}

/// `Util.applyTransform` on a point.
pub fn apply_point(x: f64, y: f64, m: &[f64]) -> (f64, f64) {
    (x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5])
}

/// `Math.min` of JavaScript: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// `Math.max` of JavaScript: NaN wins.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Util.pointBoundingBox`; the box is a `Float32Array`.
pub fn point_bounding_box(x: f64, y: f64, min_max: &mut [f32; 4]) {
    min_max[0] = js_min(f64::from(min_max[0]), x) as f32;
    min_max[1] = js_min(f64::from(min_max[1]), y) as f32;
    min_max[2] = js_max(f64::from(min_max[2]), x) as f32;
    min_max[3] = js_max(f64::from(min_max[3]), y) as f32;
}

/// `Util.rectBoundingBox`.
pub fn rect_bounding_box(x0: f64, y0: f64, x1: f64, y1: f64, min_max: &mut [f32; 4]) {
    min_max[0] = js_min(js_min(f64::from(min_max[0]), x0), x1) as f32;
    min_max[1] = js_min(js_min(f64::from(min_max[1]), y0), y1) as f32;
    min_max[2] = js_max(js_max(f64::from(min_max[2]), x0), x1) as f32;
    min_max[3] = js_max(js_max(f64::from(min_max[3]), y0), y1) as f32;
}

/// `Util.#getExtremumOnCurve`; `p` is `[x0, x1, x2, x3, y0, y1, y2, y3]`.
fn extremum_on_curve(p: [f64; 8], t: f64, min_max: &mut [f32; 4]) {
    if t <= 0.0 || t >= 1.0 {
        return;
    }
    let [x0, x1, x2, x3, y0, y1, y2, y3] = p;
    let mt = 1.0 - t;
    let tt = t * t;
    let ttt = tt * t;
    let x = mt * (mt * (mt * x0 + 3.0 * t * x1) + 3.0 * tt * x2) + ttt * x3;
    let y = mt * (mt * (mt * y0 + 3.0 * t * y1) + 3.0 * tt * y2) + ttt * y3;
    point_bounding_box(x, y, min_max);
}

/// `Util.#getExtremum`.
fn extremum(p: [f64; 8], a: f64, b: f64, c: f64, min_max: &mut [f32; 4]) {
    if a.abs() < 1e-12 {
        if b.abs() >= 1e-12 {
            extremum_on_curve(p, -c / b, min_max);
        }
        return;
    }
    let delta = b * b - 4.0 * c * a;
    if delta < 0.0 {
        return;
    }
    let sqrt_delta = delta.sqrt();
    let a2 = 2.0 * a;
    extremum_on_curve(p, (-b + sqrt_delta) / a2, min_max);
    extremum_on_curve(p, (-b - sqrt_delta) / a2, min_max);
}

/// `Util.bezierBoundingBox` of the curve from `(x0, y0)` through the control points to `(x3, y3)`.
#[allow(clippy::too_many_arguments)]
pub fn bezier_bounding_box(x0: f64, y0: f64, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64, min_max: &mut [f32; 4]) {
    min_max[0] = js_min(js_min(f64::from(min_max[0]), x0), x3) as f32;
    min_max[1] = js_min(js_min(f64::from(min_max[1]), y0), y3) as f32;
    min_max[2] = js_max(js_max(f64::from(min_max[2]), x0), x3) as f32;
    min_max[3] = js_max(js_max(f64::from(min_max[3]), y0), y3) as f32;
    let p = [x0, x1, x2, x3, y0, y1, y2, y3];
    extremum(p, 3.0 * (-x0 + 3.0 * (x1 - x2) + x3), 6.0 * (x0 - 2.0 * x1 + x2), 3.0 * (x1 - x0), min_max);
    extremum(p, 3.0 * (-y0 + 3.0 * (y1 - y2) + y3), 6.0 * (y0 - 2.0 * y1 + y2), 3.0 * (y1 - y0), min_max);
}

/// `Util.axialAlignedBoundingBox`: the box of `rect` under `transform`, joined into `output`.
pub fn axial_aligned_bounding_box(rect: &[f32; 4], transform: &[f64], output: &mut [f32; 4]) {
    let (m0, m1, m2, m3, m4, m5) = (transform[0], transform[1], transform[2], transform[3], transform[4], transform[5]);
    let (r0, r1, r2, r3) = (f64::from(rect[0]), f64::from(rect[1]), f64::from(rect[2]), f64::from(rect[3]));
    let mut a0 = m0 * r0 + m4;
    let mut a2 = a0;
    let mut a1 = m0 * r2 + m4;
    let mut a3 = a1;
    let mut b0 = m3 * r1 + m5;
    let mut b2 = b0;
    let mut b1 = m3 * r3 + m5;
    let mut b3 = b1;
    if m1 != 0.0 || m2 != 0.0 {
        let m1r0 = m1 * r0;
        let m1r2 = m1 * r2;
        let m2r1 = m2 * r1;
        let m2r3 = m2 * r3;
        a0 += m2r1;
        a3 += m2r1;
        a1 += m2r3;
        a2 += m2r3;
        b0 += m1r0;
        b3 += m1r0;
        b1 += m1r2;
        b2 += m1r2;
    }
    let min4 = |first: f64, v: [f64; 4]| v.iter().fold(first, |acc, &x| js_min(acc, x));
    let max4 = |first: f64, v: [f64; 4]| v.iter().fold(first, |acc, &x| js_max(acc, x));
    output[0] = min4(f64::from(output[0]), [a0, a1, a2, a3]) as f32;
    output[1] = min4(f64::from(output[1]), [b0, b1, b2, b3]) as f32;
    output[2] = max4(f64::from(output[2]), [a0, a1, a2, a3]) as f32;
    output[3] = max4(f64::from(output[3]), [b0, b1, b2, b3]) as f32;
}

/// `Util.normalizeRect`.
pub fn normalize_rect(rect: [f64; 4]) -> [f64; 4] {
    let mut r = rect;
    if rect[0] > rect[2] {
        r[0] = rect[2];
        r[2] = rect[0];
    }
    if rect[1] > rect[3] {
        r[1] = rect[3];
        r[3] = rect[1];
    }
    r
}

/// The part of `EvalState` the evaluator reads. A clone shares nothing mutable with its source (pdf.js clones
/// through the prototype chain and copies on write).
#[derive(Clone)]
pub struct EvalState {
    pub ctm: Matrix,
    pub font: Option<FontHandle>,
    pub text_rendering_mode: i64,
    pub fill_color_space: Arc<ColorSpace>,
    pub stroke_color_space: Arc<ColorSpace>,
    /// `patternFillColorSpace`: the last colour space set by `cs` (or a device colour operator).
    pub pattern_fill_color_space: Option<Arc<ColorSpace>>,
    pub pattern_stroke_color_space: Option<Arc<ColorSpace>>,
    pub current_point: (f64, f64),
    pub path_min_max: [f32; 4],
    pub path_buffer: Vec<f64>,
}

impl EvalState {
    pub fn new() -> Self {
        EvalState {
            ctm: IDENTITY,
            font: None,
            text_rendering_mode: 0,
            fill_color_space: ColorSpace::gray(),
            stroke_color_space: ColorSpace::gray(),
            pattern_fill_color_space: None,
            pattern_stroke_color_space: None,
            current_point: (0.0, 0.0),
            path_min_max: BBOX_INIT,
            path_buffer: Vec::new(),
        }
    }

    /// `clone({ newPath })`: the path is the clone's own and empty when `new_path`.
    pub fn cloned(&self, new_path: bool) -> EvalState {
        let mut clone = self.clone();
        if new_path {
            clone.path_buffer = Vec::new();
            clone.path_min_max = BBOX_INIT;
        }
        clone
    }

    /// The `fillColorSpace` setter: it also sets `patternFillColorSpace`.
    pub fn set_fill_color_space(&mut self, space: Arc<ColorSpace>) {
        self.pattern_fill_color_space = Some(space.clone());
        self.fill_color_space = space;
    }

    /// The `strokeColorSpace` setter.
    pub fn set_stroke_color_space(&mut self, space: Arc<ColorSpace>) {
        self.pattern_stroke_color_space = Some(space.clone());
        self.stroke_color_space = space;
    }
}

impl Default for EvalState {
    fn default() -> Self {
        EvalState::new()
    }
}

/// `StateManager`: the current state and the saved ones (`q` / `Q`).
pub struct StateManager {
    pub state: EvalState,
    stack: Vec<EvalState>,
}

impl StateManager {
    pub fn new(initial: EvalState) -> Self {
        StateManager { state: initial, stack: Vec::new() }
    }

    pub fn save(&mut self) {
        let copy = self.state.cloned(false);
        let old = std::mem::replace(&mut self.state, copy);
        self.stack.push(old);
    }

    pub fn restore(&mut self) {
        if let Some(previous) = self.stack.pop() {
            self.state = previous;
        }
    }

    pub fn transform(&mut self, args: &[f64]) {
        self.state.ctm = transform(&self.state.ctm, args);
    }

    /// `savedStatesDepth`.
    pub fn saved_depth(&self) -> usize {
        self.stack.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transform_composes_like_util_transform() {
        let m = transform(&[2.0, 0.0, 0.0, 2.0, 1.0, 1.0], &[1.0, 0.0, 0.0, 1.0, 3.0, 4.0]);
        assert_eq!(m, [2.0, 0.0, 0.0, 2.0, 7.0, 9.0]);
    }

    #[test]
    fn bezier_box_includes_the_extremum() {
        let mut b = BBOX_INIT;
        bezier_bounding_box(0.0, 0.0, 0.0, 10.0, 10.0, 10.0, 10.0, 0.0, &mut b);
        assert_eq!(b, [0.0, 0.0, 10.0, 7.5]);
    }

    #[test]
    fn save_and_restore_keep_the_matrix() {
        let mut m = StateManager::new(EvalState::new());
        m.save();
        m.transform(&[2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
        assert_eq!(m.state.ctm[0], 2.0);
        m.restore();
        assert_eq!(m.state.ctm[0], 1.0);
        m.restore();
        assert_eq!(m.saved_depth(), 0);
    }

    #[test]
    fn rect_box_is_single_precision() {
        let mut b = BBOX_INIT;
        rect_bounding_box(0.1, 0.2, 0.3, 0.4, &mut b);
        assert_eq!(b[0], 0.1_f32);
        assert_eq!(b[3], 0.4_f32);
    }
}
