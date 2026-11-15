//! `render-air.mjs`: air on the rendered page, read the way AeSlides reads whitespace: a local-variance map over a
//! downsampled greyscale, thresholded, with the outer border dropped (peripheral margin is meant to be empty). A region
//! with no local pixel variation is air whether the surface is paper, a dark field or the flat sky inside a picture,
//! which is exactly what the shape footprint cannot see. The downsample stands in for the smoothing pass: a texture
//! finer than one cell averages out. Numbers, never a verdict.

use mixdog_js::math::{max, round};
use mixdog_js::{json_number, to_number_of};
use mixdog_raster::Image;
use serde_json::{Value, json};

use crate::aesthetics_metrics::rounded;
use crate::rendered::{node_base64, paint_on_white, rendered_page_images};
use crate::field;

/// How far from the background tone a pixel must sit to read as ink.
const INK_TOLERANCE: f64 = 0.04;
/// How the weight map splits between a pixel's deviation from the page median and its local contrast; DeepSlides
/// mixes them evenly.
const LOCAL_CONTRAST_SHARE: f64 = 0.5;

/// The knobs of [`rendered_air`]: the width of the downsample, the local window and the variance threshold (shares of
/// the width and of the peak variance) and the border dropped.
#[derive(Clone, Copy, Debug)]
pub struct AirOptions {
    pub width: f64,
    pub window: f64,
    pub threshold: f64,
    pub border: f64,
}

impl Default for AirOptions {
    fn default() -> Self {
        Self { width: 320.0, window: 0.05, threshold: 0.05, border: 0.04 }
    }
}

/// The visual-weight balance (DeepSlides, arXiv 2605.26451 section C.2): the weight centre of mass (centred = 1 at
/// dead centre, 0 at a corner) and the left/right and top/bottom weight shares (1 = even, 0 = all on one side).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Balance {
    pub centered: f64,
    pub left_right: f64,
    pub top_bottom: f64,
    pub score: f64,
}

/// What [`rendered_air`] reads: `air` a share in [0, 1] (`None` for a page with no cell inside the border), `balance`
/// the visual-weight read, `colour` the page's colourfulness, `largest` the share of the biggest connected object.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Air {
    pub air: Option<f64>,
    pub balance: Option<Balance>,
    pub colour: f64,
    pub largest: f64,
}

impl Air {
    /// The record Node answered: `{ air, balance, colour, largest }`.
    pub fn to_value(&self) -> Value {
        let balance = self.balance.map_or(Value::Null, |balance| {
            json!({
                "centered": json_number(balance.centered),
                "leftRight": json_number(balance.left_right),
                "topBottom": json_number(balance.top_bottom),
                "score": json_number(balance.score),
            })
        });
        json!({
            "air": self.air.map_or(Value::Null, json_number),
            "balance": balance,
            "colour": json_number(self.colour),
            "largest": json_number(self.largest),
        })
    }
}

/// `renderedAir(base64, options)`: `None` when the image cannot be read.
pub fn rendered_air(base64: &str, options: &AirOptions) -> Option<Air> {
    let loaded = Image::decode(&node_base64(base64)).ok()?;
    let (source_width, source_height) = (f64::from(loaded.width()), f64::from(loaded.height()));
    let w = max(32.0, round(options.width)) as usize;
    let h = max(18.0, round((source_height / source_width) * w as f64)) as usize;
    let pixels = paint_on_white(Some(&loaded), w as u32, h as u32, true).ok()?;
    let pixels = pixels.data();
    let mut gray = vec![0.0f64; w * h];
    // Colourfulness (Hasler & Susstrunk 2003) of the whole page, the scale the reference reads use: rg = R - G,
    // yb = (R + G) / 2 - B; sqrt(sigma_rg^2 + sigma_yb^2) + 0.3 * sqrt(mu_rg^2 + mu_yb^2). Paper with black type
    // reads under 10, a page with one accent chart 15-30, a saturated field or a picture 40-90. Across a deck its
    // spread is the colour pacing: the frontier decks run 16-36, a one-template IR deck 5-8.
    let (mut rg, mut yb, mut rg2, mut yb2) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for (i, value) in gray.iter_mut().enumerate() {
        let o = i * 4;
        let (red, green, blue) = (f64::from(pixels[o]), f64::from(pixels[o + 1]), f64::from(pixels[o + 2]));
        *value = (0.299 * red + 0.587 * green + 0.114 * blue) / 255.0;
        let a = red - green;
        let b = (red + green) / 2.0 - blue;
        rg += a;
        yb += b;
        rg2 += a * a;
        yb2 += b * b;
    }
    let n = (w * h) as f64;
    let colour = (max(0.0, rg2 / n - (rg / n) * (rg / n)) + max(0.0, yb2 / n - (yb / n) * (yb / n))).sqrt()
        + 0.3 * ((rg / n) * (rg / n) + (yb / n) * (yb / n)).sqrt();
    // Integral images of x and x^2 give the local mean and variance in constant time per cell.
    let stride = w + 1;
    let mut sum = vec![0.0f64; stride * (h + 1)];
    let mut sq = vec![0.0f64; stride * (h + 1)];
    for y in 1..=h {
        let (mut row, mut row_sq) = (0.0f64, 0.0f64);
        for x in 1..=w {
            let v = gray[(y - 1) * w + (x - 1)];
            row += v;
            row_sq += v * v;
            sum[y * stride + x] = sum[(y - 1) * stride + x] + row;
            sq[y * stride + x] = sq[(y - 1) * stride + x] + row_sq;
        }
    }
    let r = max(1.0, round(w as f64 * options.window)) as usize;
    let mut variance = vec![0.0f64; w * h];
    let mut peak = 0.0f64;
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let cells = ((y1 - y0) * (x1 - x0)) as f64;
            let s = sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0];
            let s2 = sq[y1 * stride + x1] - sq[y0 * stride + x1] - sq[y1 * stride + x0] + sq[y0 * stride + x0];
            let v = max(0.0, s2 / cells - (s / cells) * (s / cells));
            variance[y * w + x] = v;
            if v > peak {
                peak = v;
            }
        }
    }
    let bx = round(w as f64 * options.border) as usize;
    let by = round(h as f64 * options.border) as usize;
    let (mut cells, mut air) = (0.0f64, 0.0f64);
    for y in by..h.saturating_sub(by) {
        for x in bx..w.saturating_sub(bx) {
            cells += 1.0;
            if peak == 0.0 || variance[y * w + x] / peak < options.threshold {
                air += 1.0;
            }
        }
    }
    Some(Air {
        air: if cells != 0.0 { Some(rounded(air / cells, 2)) } else { None },
        balance: weight_balance(&gray, &sum, stride, w, h, r),
        colour: rounded(colour, 1),
        largest: largest_object(&gray, w, h),
    })
}

/// The largest object on the page: the share of the canvas the biggest connected region of non-background pixels
/// covers (a chart's frame with its bars, a picture, a dark field, a table), the way the reference reads measured it
/// (thirteen decks: 0.21-0.71, median 0.4). The background is the tone the borders show; a pixel more than
/// [`INK_TOLERANCE`] away from it is ink, and ink is joined four ways.
fn largest_object(gray: &[f64], w: usize, h: usize) -> f64 {
    let mut border = Vec::with_capacity(2 * (w + h));
    for x in 0..w {
        border.push(gray[x]);
        border.push(gray[(h - 1) * w + x]);
    }
    for y in 0..h {
        border.push(gray[y * w]);
        border.push(gray[y * w + w - 1]);
    }
    border.sort_by(f64::total_cmp);
    let background = border[border.len() / 2];
    let is_ink = |index: usize| (gray[index] - background).abs() > INK_TOLERANCE;
    let mut seen = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    let mut best = 0usize;
    for start in 0..w * h {
        if seen[start] || !is_ink(start) {
            continue;
        }
        let mut size = 0usize;
        stack.push(start);
        seen[start] = true;
        while let Some(i) = stack.pop() {
            size += 1;
            let x = i % w;
            let y = i / w;
            let neighbours = [
                (x > 0).then(|| i - 1),
                (x < w - 1).then(|| i + 1),
                (y > 0).then(|| i - w),
                (y < h - 1).then(|| i + w),
            ];
            for j in neighbours.into_iter().flatten() {
                if seen[j] || !is_ink(j) {
                    continue;
                }
                seen[j] = true;
                stack.push(j);
            }
        }
        best = best.max(size);
    }
    rounded(best as f64 / (w * h) as f64, 2)
}

/// A weight map mixing each pixel's deviation from the page's median tone with its local contrast; from it the weight
/// centre of mass and the left/right and top/bottom weight shares. A page whose title band is empty and whose content
/// sits low reads as `top_bottom` well under 1: the number for "the top is empty".
fn weight_balance(gray: &[f64], sum: &[f64], stride: usize, w: usize, h: usize, r: usize) -> Option<Balance> {
    let mut sorted = gray.to_vec();
    sorted.sort_by(f64::total_cmp);
    let median = sorted[sorted.len() / 2];
    let (mut total, mut sx, mut sy, mut left, mut top) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let cells = ((y1 - y0) * (x1 - x0)) as f64;
            let local = (sum[y1 * stride + x1] - sum[y0 * stride + x1] - sum[y1 * stride + x0] + sum[y0 * stride + x0]) / cells;
            let v = gray[y * w + x];
            let weight = (1.0 - LOCAL_CONTRAST_SHARE) * (v - median).abs() + LOCAL_CONTRAST_SHARE * (v - local).abs();
            let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
            total += weight;
            sx += weight * px;
            sy += weight * py;
            if px < w as f64 / 2.0 {
                left += weight;
            }
            if py < h as f64 / 2.0 {
                top += weight;
            }
        }
    }
    if total == 0.0 {
        return None;
    }
    let (half_w, half_h) = (w as f64 / 2.0, h as f64 / 2.0);
    let (cx, cy) = (sx / total, sy / total);
    let dx = (cx - half_w) / half_w;
    let dy = (cy - half_h) / half_h;
    let centered = 1.0 - (dx * dx + dy * dy).sqrt() / std::f64::consts::SQRT_2;
    let left_right = 1.0 - (2.0 * left - total).abs() / total;
    let top_bottom = 1.0 - (2.0 * top - total).abs() / total;
    let clamp = |v: f64| rounded(v.clamp(0.0, 1.0), 2);
    Some(Balance {
        centered: clamp(centered),
        left_right: clamp(left_right),
        top_bottom: clamp(top_bottom),
        score: clamp((centered + left_right + top_bottom) / 3.0),
    })
}

/// `renderedAirByPage(images)`: every rendered page of a deck (contact sheets unfolded to their pages), in the order
/// each page was first met, as page number and its reading. A page whose image cannot be read, or reads no air, is
/// left out.
pub fn rendered_air_by_page(images: &[Value]) -> Vec<(f64, Air)> {
    let mut by_page: Vec<(f64, Air)> = Vec::new();
    for image in rendered_page_images(images) {
        let pages: Vec<f64> = match field(&image, "pages") {
            Some(Value::Array(pages)) => pages.iter().map(mixdog_js::to_number).collect(),
            _ => vec![to_number_of(field(&image, "page"))],
        };
        let Some(Value::String(data)) = field(&image, "data").filter(|data| crate::is_truthy(Some(*data))) else {
            continue;
        };
        if pages.len() != 1 {
            continue;
        }
        let Some(read) = rendered_air(data, &AirOptions::default()) else { continue };
        if read.air.is_none() {
            continue;
        }
        match by_page.iter_mut().find(|(page, _)| *page == pages[0] || (page.is_nan() && pages[0].is_nan())) {
            Some(slot) => slot.1 = read,
            None => by_page.push((pages[0], read)),
        }
    }
    by_page
}

#[cfg(test)]
mod tests {
    use mixdog_raster::canvas::Canvas;
    use serde_json::{Value, json};

    use super::*;
    use crate::rendered::test_pages::{painted, rect};

    fn page(paint: impl FnOnce(&mut Canvas)) -> String {
        painted(640, 360, paint)
    }

    fn air(data: &str) -> Air {
        rendered_air(data, &AirOptions::default()).expect("a readable page")
    }

    #[test]
    fn rendered_air_reads_flat_regions_as_air_on_paper_and_on_a_dark_field_alike() {
        let light_sparse = page(|c| {
            rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0);
            rect(c, "#111111", 40.0, 40.0, 200.0, 30.0);
        });
        let dark_sparse = page(|c| {
            rect(c, "#0f1b26", 0.0, 0.0, 640.0, 360.0);
            rect(c, "#f8fafc", 40.0, 40.0, 200.0, 30.0);
        });
        let dense = page(|c| {
            rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0);
            let mut y = 30;
            while y < 330 {
                let mut x = 30;
                while x < 610 {
                    let colour = if (x + y) % 80 != 0 { "#222222" } else { "#0e7c86" };
                    rect(c, colour, x as f32, y as f32, 28.0, 12.0);
                    x += 40;
                }
                y += 24;
            }
        });
        let light = air(&light_sparse).air.expect("air");
        let dark = air(&dark_sparse).air.expect("air");
        let busy_read = air(&dense);
        let busy = busy_read.air.expect("air");
        assert!(light > 0.8, "a mostly empty light page: {light}");
        assert!((light - dark).abs() < 0.05, "the surface colour does not change the reading: {light} vs {dark}");
        assert!(busy < 0.3, "a page full of text rows: {busy}");
        // Balance: the evenly filled page is balanced; a page whose only mark sits in the top-left corner is not.
        let even = busy_read.balance.expect("balance");
        assert!(even.score > 0.85 && even.top_bottom > 0.9, "even rows balance top and bottom: {even:?}");
        let corner = air(&light_sparse).balance.expect("balance");
        assert!(corner.top_bottom < 0.5 && corner.left_right < 0.7 && corner.centered < 0.8, "one block in the top-left corner: {corner:?}");
        // Colourfulness: paper with black type reads near zero; the same page with a teal chart field reads as colour.
        let accent = page(|c| {
            rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0);
            rect(c, "#111111", 40.0, 40.0, 200.0, 30.0);
            rect(c, "#0e7c86", 40.0, 120.0, 400.0, 200.0);
        });
        let quiet = air(&light_sparse).colour;
        let coloured = air(&accent).colour;
        assert!(quiet < 5.0, "black on white: {quiet}");
        assert!(coloured > 15.0 && coloured > quiet * 3.0, "a teal field over a third of the page: {coloured}");
        // The largest object: the teal field (400 x 200 of 640 x 360 = 0.35) on the accent page; the one title block
        // (200 x 30 = 0.026) on the sparse page; the dense rows are many small objects, none large.
        let big = air(&accent).largest;
        let small = air(&light_sparse).largest;
        let rows = air(&dense).largest;
        assert!(big > 0.3 && big < 0.4, "the teal field: {big}");
        assert!(small < 0.05, "one title block: {small}");
        assert!(rows < 0.02, "rows of separate blocks: {rows}");
    }

    #[test]
    fn rendered_air_maps_every_page_of_a_deck_and_unfolds_a_contact_sheet_to_its_pages() {
        let filled = page(|c| {
            rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0);
            let mut y = 30;
            while y < 330 {
                rect(c, "#333333", 30.0, y as f32, 580.0, 8.0);
                y += 20;
            }
        });
        let empty = page(|c| rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0));
        let by_page = rendered_air_by_page(&[
            json!({ "page": 1, "data": filled }),
            json!({
                "page": 2,
                "pages": [2, 3],
                "data": empty,
                "pageImages": [{ "page": 2, "data": empty }, { "page": 3, "data": filled }],
            }),
        ]);
        let pages: Vec<f64> = by_page.iter().map(|(page, _)| *page).collect();
        assert_eq!(pages, [1.0, 2.0, 3.0]);
        let air_of = |page: usize| by_page[page].1.air.expect("air");
        assert!(air_of(0) < air_of(1));
        assert_eq!(air_of(2), air_of(0));
        assert!(by_page[0].1.balance.is_some());
        assert_eq!(rendered_air("not-an-image", &AirOptions::default()), None);
    }

    #[test]
    fn the_record_is_the_object_node_answered() {
        let flat = page(|c| rect(c, "#ffffff", 0.0, 0.0, 640.0, 360.0));
        let value: Value = air(&flat).to_value();
        assert_eq!(value["balance"], Value::Null);
        assert_eq!(value["air"], json!(1));
        assert_eq!(value["largest"], json!(0));
    }
}
