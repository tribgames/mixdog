//! Fitting a captured frame for the model: size, downscale and region crop
//! (computerCaptureSize, capture-size.mjs; cropZoom, zoom-region.ts).

use super::frame_quality::Region;
use serde_json::Value;

const PATCH_SIZE: u32 = 28;
const MAX_PATCHES: u32 = 1568;
const MAX_EDGE: u32 = 1568;

/// The size a capture is bound at: the largest that keeps its width within
/// `max_width` and its patch count within the encoder budget
/// (computerCaptureSize). Never larger than the frame.
pub fn capture_size(width: u32, height: u32, max_width: u32) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 || max_width == 0 {
        return Err("capture_geometry_invalid: positive integer dimensions are required".into());
    }
    let longest = width.max(height);
    let at = |edge: u32| {
        let scale = (f64::from(edge) / f64::from(longest)).min(1.0);
        (
            ((f64::from(width) * scale).floor() as u32).max(1),
            ((f64::from(height) * scale).floor() as u32).max(1),
        )
    };
    let fits = |(w, h): (u32, u32)| {
        w <= max_width && w.div_ceil(PATCH_SIZE) * h.div_ceil(PATCH_SIZE) <= MAX_PATCHES
    };
    let (mut low, mut high) = (1, longest.min(MAX_EDGE));
    while low < high {
        let edge = (low + high).div_ceil(2);
        if fits(at(edge)) {
            low = edge;
        } else {
            high = edge - 1;
        }
    }
    Ok(at(low))
}

/// Four-byte pixels, row by row without padding.
#[derive(Clone, Debug, PartialEq)]
pub struct Pixels {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl Pixels {
    /// The `region` of this frame (already inside it, see `local_region`).
    pub fn crop(&self, region: Region) -> Pixels {
        let (x, y) = (region.x as usize, region.y as usize);
        let (width, height) = (region.width as usize, region.height as usize);
        let mut data = Vec::with_capacity(width * height * 4);
        for row in y..y + height {
            let start = (row * self.width + x) * 4;
            data.extend_from_slice(&self.data[start..start + width * 4]);
        }
        Pixels { width, height, data }
    }

    /// A box-filter resize: each target pixel is the mean of the source
    /// pixels it covers. Meant for shrinking; a larger target repeats pixels.
    pub fn resize(&self, width: usize, height: usize) -> Pixels {
        if (width, height) == (self.width, self.height) {
            return self.clone();
        }
        let mut data = Vec::with_capacity(width * height * 4);
        for ty in 0..height {
            let (y0, y1) = span(ty, height, self.height);
            for tx in 0..width {
                let (x0, x1) = span(tx, width, self.width);
                let mut sum = [0u32; 4];
                for y in y0..y1 {
                    for x in x0..x1 {
                        let at = (y * self.width + x) * 4;
                        for (channel, total) in sum.iter_mut().enumerate() {
                            *total += u32::from(self.data[at + channel]);
                        }
                    }
                }
                let count = ((y1 - y0) * (x1 - x0)) as u32;
                data.extend(sum.iter().map(|total| ((total + count / 2) / count) as u8));
            }
        }
        Pixels { width, height, data }
    }
}

/// The source range one target index covers; at least one source pixel.
fn span(index: usize, target: usize, source: usize) -> (usize, usize) {
    let start = (index * source / target).min(source - 1);
    let end = ((index + 1) * source).div_ceil(target).clamp(start + 1, source);
    (start, end)
}

/// A physical screen rectangle cut to the surface at `(x, y)` of size
/// `width` x `height`, as a rectangle of the surface's own pixels. Refused
/// when none of it lies on the surface.
pub fn local_region(surface: (i32, i32, i32, i32), wanted: Region) -> Result<Region, String> {
    let (sx, sy, sw, sh) = surface;
    let x0 = wanted.x.max(sx);
    let y0 = wanted.y.max(sy);
    let x1 = wanted.x.saturating_add(wanted.width).min(sx.saturating_add(sw));
    let y1 = wanted.y.saturating_add(wanted.height).min(sy.saturating_add(sh));
    if wanted.width < 1 || wanted.height < 1 || x1 <= x0 || y1 <= y0 {
        return Err(format!(
            "capture_region_invalid: region {},{} {}x{} does not overlap the captured surface {sx},{sy} {sw}x{sh}",
            wanted.x, wanted.y, wanted.width, wanted.height
        ));
    }
    Ok(Region { x: x0 - sx, y: y0 - sy, width: x1 - x0, height: y1 - y0 })
}

/// Projects the words and lines of an OCR result from the `from` image
/// onto the `to` one, so their boxes are pixels of the frame the model sees.
pub fn map_ocr(ocr: &mut Value, from: (f64, f64), to: (usize, usize)) {
    let (kx, ky) = (to.0 as f64 / from.0, to.1 as f64 / from.1);
    for list in ["words", "lines"] {
        let Some(rows) = ocr.get_mut(list).and_then(Value::as_array_mut) else {
            continue;
        };
        for row in rows {
            for (key, k) in [
                ("x", kx),
                ("width", kx),
                ("center_x", kx),
                ("y", ky),
                ("height", ky),
                ("center_y", ky),
            ] {
                if let Some(number) = row.get(key).and_then(Value::as_f64) {
                    row[key] = Value::from((number * k).round() as i64);
                }
            }
        }
    }
    ocr["image_width"] = Value::from(to.0);
    ocr["image_height"] = Value::from(to.1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn size(width: u32, height: u32, max_width: u32) -> (u32, u32) {
        capture_size(width, height, max_width).expect("sized")
    }

    #[test]
    fn a_small_frame_is_kept() {
        assert_eq!(size(300, 200, 1280), (300, 200));
        assert_eq!(size(1, 1, 1280), (1, 1));
    }

    #[test]
    fn a_wide_frame_is_fitted_to_the_width_cap() {
        let (w, h) = size(3840, 2160, 1280);
        assert!(w <= 1280 && w > 1200, "{w}");
        assert!((f64::from(w) / f64::from(h) - 16.0 / 9.0).abs() < 0.05);
    }

    #[test]
    fn the_patch_budget_bounds_what_the_width_cap_allows() {
        let (w, h) = size(3840, 3840, 3840);
        assert!(w.div_ceil(28) * h.div_ceil(28) <= 1568, "{w}x{h}");
        assert!(w <= 1568 && h <= 1568);
        // It is the largest: one pixel more on each side breaks the budget.
        assert!((w + 1).div_ceil(28) * (h + 1).div_ceil(28) > 1568 || w == 1568);
    }

    #[test]
    fn a_tall_frame_keeps_its_aspect() {
        let (w, h) = size(500, 4000, 1280);
        assert!(h <= 1568);
        assert!((f64::from(w) / f64::from(h) - 0.125).abs() < 0.01);
    }

    #[test]
    fn dimensions_must_be_positive() {
        for (w, h, m) in [(0, 1, 1), (1, 0, 1), (1, 1, 0)] {
            assert!(capture_size(w, h, m).unwrap_err().starts_with("capture_geometry_invalid"));
        }
    }

    fn gradient(width: usize, height: usize) -> Pixels {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend([x as u8, y as u8, 7, 255]);
            }
        }
        Pixels { width, height, data }
    }

    #[test]
    fn a_crop_takes_the_named_pixels() {
        let part = gradient(10, 8).crop(Region { x: 2, y: 3, width: 4, height: 2 });
        assert_eq!((part.width, part.height), (4, 2));
        assert_eq!(&part.data[..4], &[2, 3, 7, 255]);
        assert_eq!(&part.data[part.data.len() - 4..], &[5, 4, 7, 255]);
    }

    #[test]
    fn a_resize_averages_what_it_covers() {
        let flat = Pixels { width: 4, height: 4, data: [10, 20, 30, 255].repeat(16) };
        let small = flat.resize(2, 2);
        assert_eq!((small.width, small.height, small.data.len()), (2, 2, 16));
        assert_eq!(&small.data[..4], &[10, 20, 30, 255]);
        let two = Pixels { width: 2, height: 1, data: vec![0, 0, 0, 255, 100, 200, 50, 255] };
        assert_eq!(two.resize(1, 1).data, vec![50, 100, 25, 255]);
    }

    #[test]
    fn a_resize_to_an_odd_size_covers_every_pixel() {
        let small = gradient(7, 5).resize(3, 2);
        assert_eq!(small.data.len(), 3 * 2 * 4);
        assert!(small.data.chunks(4).all(|px| px[3] == 255));
    }

    #[test]
    fn a_region_is_cut_to_the_surface() {
        let surface = (100, 50, 300, 200);
        assert_eq!(
            local_region(surface, Region { x: 120, y: 60, width: 40, height: 30 }),
            Ok(Region { x: 20, y: 10, width: 40, height: 30 })
        );
        assert_eq!(
            local_region(surface, Region { x: 90, y: 40, width: 50, height: 50 }),
            Ok(Region { x: 0, y: 0, width: 40, height: 40 })
        );
        assert_eq!(
            local_region(surface, Region { x: 380, y: 240, width: 100, height: 100 }),
            Ok(Region { x: 280, y: 190, width: 20, height: 10 })
        );
    }

    #[test]
    fn a_region_off_the_surface_is_refused() {
        let surface = (0, 0, 100, 100);
        for region in [
            Region { x: 100, y: 0, width: 10, height: 10 },
            Region { x: -20, y: 0, width: 10, height: 10 },
            Region { x: 0, y: 0, width: 0, height: 10 },
            Region { x: 0, y: 0, width: 10, height: -3 },
        ] {
            let error = local_region(surface, region).unwrap_err();
            assert!(error.starts_with("capture_region_invalid"), "{error}");
        }
    }

    #[test]
    fn ocr_boxes_are_mapped_into_the_delivered_frame() {
        let mut ocr = json!({
            "image_width": 2000, "image_height": 1000,
            "words": [{ "text": "a", "x": 200, "y": 100, "width": 100, "height": 50, "center_x": 250, "center_y": 125 }],
            "lines": [{ "text": "a", "x": 200, "y": 100, "width": 100, "height": 50 }],
        });
        map_ocr(&mut ocr, (2000.0, 1000.0), (1000, 500));
        assert_eq!(
            ocr["words"][0],
            json!({ "text": "a", "x": 100, "y": 50, "width": 50, "height": 25, "center_x": 125, "center_y": 63 })
        );
        assert_eq!(ocr["lines"][0]["width"], 50);
        assert_eq!((ocr["image_width"].clone(), ocr["image_height"].clone()), (json!(1000), json!(500)));
    }
}
