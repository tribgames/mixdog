//! How Skia (through `@napi-rs/canvas`) turns a glyph outline into the coverage it paints: the pen position of a glyph is
//! snapped (a quarter of a pixel across, a whole pixel down), a face that is not bold is emboldened by FreeType's
//! `FT_Outline_Embolden` when a bold weight is asked of it, and the coverage goes through the luminance-dependent
//! pre-blend table of the glyph mask (`SkMaskGamma`: contrast 0.5, the sRGB transfer function), which makes dark text
//! thinner and light text heavier than plain area coverage does.

use mixdog_fonts::autohint::Tag;
use tiny_skia::Color;
use tiny_skia::PathBuilder;

/// `SK_GAMMA_CONTRAST`.
const CONTRAST: f32 = 0.5;

fn srgb_to_linear(value: f32) -> f32 {
    if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(value: f32) -> f32 {
    if value <= 0.003_130_8 { value * 12.92 } else { 1.055 * value.powf(1.0 / 2.4) - 0.055 }
}

/// A luminance of `levels` bits scaled to eight (`sk_t_scale255`): the bits repeated.
fn scale255_3(value: u32) -> u32 {
    let base = value << 5;
    base | (base >> 3) | (base >> 6)
}

/// Skia's luminance of a colour for a glyph mask in A8 (`SkComputeLuminance`), reduced to the three bits of the tables
/// and scaled back (`SkMaskGamma::CanonicalColor`).
pub(crate) fn canonical_luminance(color: Color) -> u8 {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u32;
    let (r, g, b) = (channel(color.red()), channel(color.green()), channel(color.blue()));
    let luminance = (r * 54 + g * 183 + b * 19) >> 8;
    scale255_3(luminance >> 5) as u8
}

/// The 256-entry table that corrects coverage for a glyph of luminance `source` (`SkTMaskGamma_build_correcting_lut`).
pub(crate) fn correcting_table(source: u8) -> [u8; 256] {
    let src = f32::from(source) / 255.0;
    let lin_src = srgb_to_linear(src);
    let dst = 1.0 - src;
    let lin_dst = srgb_to_linear(dst);
    let adjusted_contrast = CONTRAST * lin_dst;
    let mut table = [0_u8; 256];
    for (index, slot) in table.iter_mut().enumerate() {
        let raw = index as f32 / 255.0;
        let alpha = raw + (1.0 - raw) * adjusted_contrast * raw;
        if (src - dst).abs() < 1.0 / 256.0 {
            *slot = (255.0 * alpha).round() as u8;
        } else {
            let lin_out = lin_src * alpha + (1.0 - alpha) * lin_dst;
            let out = linear_to_srgb(lin_out);
            let result = (out - dst) / (src - dst);
            *slot = (255.0 * result).round().clamp(0.0, 255.0) as u8;
        }
    }
    table
}

/// The pen position of a glyph on the device: a quarter of a pixel across and a whole pixel down (Skia's sub-pixel
/// positioning along the baseline), for an upright matrix; any other matrix keeps the exact position.
pub(crate) fn snap_origin(x: f32, y: f32, axis_aligned: bool) -> (f32, f32) {
    if axis_aligned { (((x + 0.125) * 4.0).floor() / 4.0, (y + 0.5).floor()) } else { (x, y) }
}

/// A contour as FreeType holds it (the points of the font, cyclic; the on-curve points between two conic control points
/// are implied), y up.
pub(crate) type Contour = Vec<(f32, f32, Tag)>;

/// The contours as a path (`FT_Outline_Decompose`): the on-curve point between two conic control points is implied, a
/// contour may start with a control point; each point is mapped by `map` (to the device).
pub(crate) fn into_path(contours: &[Contour], builder: &mut PathBuilder, map: impl Fn((f32, f32)) -> (f32, f32)) {
    for contour in contours {
        let n = contour.len();
        if n < 2 {
            continue;
        }
        let at = |i: usize| map((contour[i % n].0, contour[i % n].1));
        let mid = |a: (f32, f32), b: (f32, f32)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
        // Where the contour starts, the index of the first point still to be consumed, and where the points end.
        let (start, mut index, end) = if contour[0].2 == Tag::On {
            (at(0), 1, n)
        } else if contour[n - 1].2 == Tag::On {
            (at(n - 1), 0, n - 1)
        } else {
            (mid(at(0), at(n - 1)), 0, n)
        };
        builder.move_to(start.0, start.1);
        while index < end {
            match contour[index].2 {
                Tag::On => {
                    let p = at(index);
                    builder.line_to(p.0, p.1);
                    index += 1;
                }
                Tag::Conic => {
                    let mut control = at(index);
                    loop {
                        index += 1;
                        if index >= end {
                            builder.quad_to(control.0, control.1, start.0, start.1);
                            break;
                        }
                        let next = at(index);
                        if contour[index].2 == Tag::On {
                            builder.quad_to(control.0, control.1, next.0, next.1);
                            index += 1;
                            break;
                        }
                        let middle = mid(control, next);
                        builder.quad_to(control.0, control.1, middle.0, middle.1);
                        control = next;
                    }
                }
                Tag::Cubic => {
                    let c1 = at(index);
                    let c2 = at(index + 1);
                    let p = if index + 2 >= end { start } else { at(index + 2) };
                    builder.cubic_to(c1.0, c1.1, c2.0, c2.1, p.0, p.1);
                    index += 3;
                }
            }
        }
        builder.close();
    }
}

/// The coverage of a path rendered the way FreeType's gray rasteriser renders a glyph: the exact area of every pixel the path
/// covers (not Skia's 4x4 supersampling of paths), the winding of overlapping contours folded to a coverage of at most
/// one, in 256 levels. `data` is `width` x `height` pixels at (`left`, `top`) of the canvas.
pub(crate) struct Raster {
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// Straight line pieces of a path (FreeType's rasteriser flattens a conic into 2^k equal parts until it is within a sixteenth
/// of a pixel of its chord, and splits a cubic until its control points are within half a pixel of the chord).
fn flatten(path: &tiny_skia::Path) -> Vec<Vec<(f32, f32)>> {
    use tiny_skia::PathSegment;
    let mut contours: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut current: Vec<(f32, f32)> = Vec::new();
    for segment in path.segments() {
        match segment {
            PathSegment::MoveTo(p) => {
                if current.len() > 1 {
                    contours.push(std::mem::take(&mut current));
                }
                current.clear();
                current.push((p.x, p.y));
            }
            PathSegment::LineTo(p) => current.push((p.x, p.y)),
            PathSegment::QuadTo(c, p) => {
                let Some(&(x0, y0)) = current.last() else { continue };
                let mut dx = (((x0 + p.x - 2.0 * c.x).abs()).max((y0 + p.y - 2.0 * c.y).abs()) * 256.0) as i64;
                let mut parts = 1_u32;
                while dx > 64 {
                    dx >>= 2;
                    parts <<= 1;
                }
                for step in 1..=parts {
                    let t = step as f32 / parts as f32;
                    let u = 1.0 - t;
                    current.push((u * u * x0 + 2.0 * u * t * c.x + t * t * p.x, u * u * y0 + 2.0 * u * t * c.y + t * t * p.y));
                }
            }
            PathSegment::CubicTo(c1, c2, p) => {
                let Some(&(x0, y0)) = current.last() else { continue };
                cubic_pieces(&mut current, [(x0, y0), (c1.x, c1.y), (c2.x, c2.y), (p.x, p.y)], 0);
            }
            PathSegment::Close => {
                if current.len() > 1 {
                    let first = current[0];
                    contours.push(std::mem::take(&mut current));
                    current.push(first);
                }
            }
        }
    }
    if current.len() > 1 {
        contours.push(current);
    }
    contours
}

fn cubic_pieces(out: &mut Vec<(f32, f32)>, arc: [(f32, f32); 4], depth: u32) {
    let limit = 0.5;
    let flat = (2.0 * arc[0].0 - 3.0 * arc[1].0 + arc[3].0).abs() <= limit
        && (2.0 * arc[0].1 - 3.0 * arc[1].1 + arc[3].1).abs() <= limit
        && (arc[0].0 - 3.0 * arc[2].0 + 2.0 * arc[3].0).abs() <= limit
        && (arc[0].1 - 3.0 * arc[2].1 + 2.0 * arc[3].1).abs() <= limit;
    if flat || depth > 16 {
        out.push(arc[3]);
        return;
    }
    let mid = |a: (f32, f32), b: (f32, f32)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let (ab, bc, cd) = (mid(arc[0], arc[1]), mid(arc[1], arc[2]), mid(arc[2], arc[3]));
    let (abc, bcd) = (mid(ab, bc), mid(bc, cd));
    let m = mid(abc, bcd);
    cubic_pieces(out, [arc[0], ab, abc, m], depth + 1);
    cubic_pieces(out, [m, bcd, cd, arc[3]], depth + 1);
}

/// Renders `path` (device pixels) over a canvas of `canvas_width` x `canvas_height`; `None` when it touches no pixel.
pub(crate) fn rasterize(path: &tiny_skia::Path, canvas_width: usize, canvas_height: usize) -> Option<Raster> {
    let bounds = path.bounds();
    let left = (bounds.left().floor().max(0.0) as usize).min(canvas_width);
    let right = (bounds.right().ceil().max(0.0) as usize).min(canvas_width);
    let top = (bounds.top().floor().max(0.0) as usize).min(canvas_height);
    let bottom = (bounds.bottom().ceil().max(0.0) as usize).min(canvas_height);
    if right <= left || bottom <= top {
        return None;
    }
    let (width, height) = (right - left, bottom - top);
    // One spare column: the accumulation of a row ends one pixel past its last covered one.
    let stride = width + 2;
    let mut area = vec![0.0_f32; stride * height];
    let (ox, oy) = (left as f32, top as f32);
    for contour in flatten(path) {
        let n = contour.len();
        for index in 0..n {
            let (a, b) = (contour[index], contour[(index + 1) % n]);
            add_line(&mut area, stride, width, height, (a.0 - ox, a.1 - oy), (b.0 - ox, b.1 - oy));
        }
    }
    let mut data = vec![0_u8; width * height];
    for row in 0..height {
        let mut sum = 0.0_f32;
        for column in 0..width {
            sum += area[row * stride + column];
            data[row * width + column] = (sum.abs() * 256.0).min(255.0) as u8;
        }
    }
    Some(Raster { left, top, width, height, data })
}

/// Adds the signed area of a line to the accumulation buffer (the area to the right of the line, row by row).
pub(crate) fn add_line(area: &mut [f32], stride: usize, width: usize, height: usize, p0: (f32, f32), p1: (f32, f32)) {
    if p0.1 == p1.1 {
        return;
    }
    let (direction, p0, p1) = if p0.1 < p1.1 { (1.0_f32, p0, p1) } else { (-1.0_f32, p1, p0) };
    let slope = (p1.0 - p0.0) / (p1.1 - p0.1);
    let mut x = p0.0;
    let mut start = 0_usize;
    if p0.1 < 0.0 {
        x -= p0.1 * slope;
    } else {
        start = p0.1 as usize;
    }
    let end = (p1.1.ceil().max(0.0) as usize).min(height);
    let max_x = width as f32;
    for row in start..end {
        let line = row * stride;
        let dy = ((row + 1) as f32).min(p1.1) - (row as f32).max(p0.1);
        let next = x + slope * dy;
        let d = dy * direction;
        let (lo, hi) = if x < next { (x, next) } else { (next, x) };
        let (lo, hi) = (lo.clamp(0.0, max_x), hi.clamp(0.0, max_x));
        let lo_floor = lo.floor();
        let lo_index = lo_floor as usize;
        let hi_ceil = hi.ceil();
        let hi_index = hi_ceil as usize;
        if hi_index <= lo_index + 1 {
            let mid = 0.5 * (lo + hi) - lo_floor;
            area[line + lo_index] += d - d * mid;
            area[line + lo_index + 1] += d * mid;
        } else {
            let s = 1.0 / (hi - lo);
            let lo_fraction = lo - lo_floor;
            let first = 0.5 * s * (1.0 - lo_fraction) * (1.0 - lo_fraction);
            let hi_fraction = hi - hi_ceil + 1.0;
            let last = 0.5 * s * hi_fraction * hi_fraction;
            area[line + lo_index] += d * first;
            if hi_index == lo_index + 2 {
                area[line + lo_index + 1] += d * (1.0 - first - last);
            } else {
                let second = s * (1.5 - lo_fraction);
                area[line + lo_index + 1] += d * (second - first);
                for index in lo_index + 2..hi_index - 1 {
                    area[line + index] += d * s;
                }
                let third = second + (hi_index - lo_index - 3) as f32 * s;
                area[line + hi_index - 1] += d * (1.0 - third - last);
            }
            area[line + hi_index] += d * last;
        }
        x = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_text_is_corrected_to_the_values_skia_gave() {
        // Recorded: a stem 0.74 covered at one edge was drawn 142, one 0.06 covered 11 (black on white, contrast 0.5, sRGB).
        let table = correcting_table(canonical_luminance(Color::BLACK));
        assert_eq!(table[0], 0);
        assert_eq!(table[255], 255);
        assert!((i32::from(table[189]) - 142).abs() <= 1, "0.74 is {}", table[189]);
        assert!((i32::from(table[15]) - 11).abs() <= 1, "0.06 is {}", table[15]);
    }

    #[test]
    fn light_text_is_not_thinned() {
        let white = correcting_table(canonical_luminance(Color::WHITE));
        assert!(white[128] >= 128, "white text on dark grows or stays: {}", white[128]);
        let black = correcting_table(0);
        assert!(black[128] < 128, "black text on white thins: {}", black[128]);
    }

    #[test]
    fn the_luminance_of_a_colour_is_reduced_to_three_bits() {
        assert_eq!(canonical_luminance(Color::BLACK), 0);
        assert_eq!(canonical_luminance(Color::WHITE), 255);
        assert_eq!(canonical_luminance(Color::from_rgba8(204, 0, 0, 255)), 36);
    }

    #[test]
    fn the_pen_is_snapped_a_quarter_across_and_a_pixel_down() {
        assert_eq!(snap_origin(4.0, 24.0, true), (4.0, 24.0));
        assert_eq!(snap_origin(4.1, 24.4, true), (4.0, 24.0));
        assert_eq!(snap_origin(4.13, 24.6, true), (4.25, 25.0));
        assert_eq!(snap_origin(4.1, 24.4, false), (4.1, 24.4));
    }

    #[test]
    fn the_rasteriser_leaves_the_exact_area_of_every_pixel() {
        let mut builder = PathBuilder::new();
        builder.move_to(1.25, 1.0);
        builder.line_to(3.5, 1.0);
        builder.line_to(3.5, 3.0);
        builder.line_to(1.25, 3.0);
        builder.close();
        let raster = rasterize(&builder.finish().expect("a path"), 8, 8).expect("a raster");
        assert_eq!((raster.left, raster.top, raster.width, raster.height), (1, 1, 3, 2));
        // The first column is covered 0.75, the middle one fully, the last one half.
        assert_eq!(&raster.data[0..3], &[192, 255, 128]);
        assert_eq!(&raster.data[3..6], &[192, 255, 128]);
    }

    #[test]
    fn overlapping_contours_do_not_cover_more_than_a_pixel() {
        let mut builder = PathBuilder::new();
        for _ in 0..2 {
            builder.move_to(1.0, 1.0);
            builder.line_to(3.0, 1.0);
            builder.line_to(3.0, 3.0);
            builder.line_to(1.0, 3.0);
            builder.close();
        }
        let raster = rasterize(&builder.finish().expect("a path"), 8, 8).expect("a raster");
        assert!(raster.data.iter().all(|value| *value == 255));
    }

    #[test]
    fn an_implied_on_curve_point_between_two_control_points_is_decomposed() {
        // A contour of three conic control points and no on-curve point starts at the middle of the first and last.
        let contour: Contour = vec![(0.0, 0.0, Tag::Conic), (4.0, 0.0, Tag::Conic), (4.0, 4.0, Tag::Conic)];
        let mut builder = PathBuilder::new();
        into_path(&[contour], &mut builder, |point| point);
        let path = builder.finish().expect("a path");
        assert!(path.bounds().width() > 0.0 && path.bounds().height() > 0.0);
    }
}
