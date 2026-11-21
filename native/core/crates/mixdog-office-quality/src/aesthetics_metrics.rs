//! Rendered-page sampling for the aesthetic review, one metric record per page image
//! (luminance, colourfulness, foreground occupancy, a 16x9 structure grid, ink contrast). No judgement lives here;
//! [`crate::aesthetics`] reads these. The page is flattened on white and resampled to 160x90 (640x360 for the ink read)
//! with the Lanczos3 `fill` resize sharp used, so the numbers are the ones the Node review read.

use std::collections::HashMap;

use mixdog_js::math::{max, min, round, to_fixed};
use mixdog_js::to_number_of;
use mixdog_office_base::values::clamp;
use mixdog_raster::ops::{Kernel, greyscale, resize_exact};
use serde_json::Value;

use crate::field;
use crate::rendered::decode_image;

const SAMPLE_WIDTH: usize = 160;
const SAMPLE_HEIGHT: usize = 90;
pub(crate) const STRUCTURE_COLUMNS: usize = 16;
pub(crate) const STRUCTURE_ROWS: usize = 9;
const INK_WIDTH: u32 = 640;
const INK_HEIGHT: u32 = 360;
const INK_FOREGROUND: f64 = 28.0 / 255.0;

/// `Number(Number(value).toFixed(digits))` with `Number(value) || 0` first (`rounded(value, digits)`).
pub(crate) fn rounded(value: f64, digits: usize) -> f64 {
    let value = if value.is_nan() { 0.0 } else { value };
    to_fixed(value, digits).parse().unwrap_or(0.0)
}

/// `mean(values)`: the sum taken in order, 0 for no values.
pub(crate) fn mean(values: &[f64]) -> f64 {
    if values.is_empty() { 0.0 } else { values.iter().fold(0.0, |total, value| total + value) / values.len() as f64 }
}

/// `deviation(values)`: the population standard deviation, 0 for no values.
pub(crate) fn deviation(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let center = mean(values);
    let squares: Vec<f64> = values.iter().map(|value| (value - center) * (value - center)).collect();
    mean(&squares).sqrt()
}

/// One page's reading. `structure` is the 16x9 occupancy grid (the Node `_structure`, which the answer drops).
#[derive(Clone, Debug)]
pub(crate) struct PageMetric {
    pub page: f64,
    pub width: f64,
    pub height: f64,
    pub background_luminance: f64,
    pub luminance_mean: f64,
    pub contrast_span: f64,
    pub foreground_contrast: f64,
    pub ink_contrast: f64,
    pub colorfulness: f64,
    pub colorfulness_score: f64,
    pub accent_coverage: f64,
    pub palette_hue_count: usize,
    pub palette_dominance: f64,
    pub entropy: f64,
    pub edge_density: f64,
    pub foreground_coverage: f64,
    pub spatial_coverage: f64,
    pub spatial_balance: f64,
    pub occupied_quadrants: usize,
    pub structure: Vec<f64>,
}

/// The page number of an image: its single `pages` entry, else its `page`, else its place in the list (from 1).
fn page_number(image: &Value, index: usize) -> f64 {
    let fallback = (index + 1) as f64;
    let truthy = |number: f64| !number.is_nan() && number != 0.0;
    if let Some(Value::Array(pages)) = field(image, "pages") {
        if pages.len() == 1 {
            let number = mixdog_js::to_number(&pages[0]);
            return if truthy(number) { number } else { fallback };
        }
    }
    let number = to_number_of(field(image, "page"));
    if truthy(number) { number } else { fallback }
}

/// The most frequent colour among the sampled pixels (quantised to 32 levels per channel), averaged over its members
/// so the estimate is a real page colour. No colour owning half of them means no background to speak of: the mean.
fn dominant_color(pixels: &[[f64; 3]]) -> [f64; 3] {
    if pixels.is_empty() {
        return [255.0, 255.0, 255.0];
    }
    struct Bin {
        count: f64,
        sum: [f64; 3],
    }
    let mut order: Vec<Bin> = Vec::new();
    let mut at: HashMap<(i32, i32, i32), usize> = HashMap::new();
    for pixel in pixels {
        let key = (pixel[0] as i32 >> 3, pixel[1] as i32 >> 3, pixel[2] as i32 >> 3);
        let slot = *at.entry(key).or_insert_with(|| {
            order.push(Bin { count: 0.0, sum: [0.0; 3] });
            order.len() - 1
        });
        let bin = &mut order[slot];
        bin.count += 1.0;
        for channel in 0..3 {
            bin.sum[channel] += pixel[channel];
        }
    }
    // The sort is stable and descending by count, so the first bin of the highest count wins a tie.
    let mut top = &order[0];
    for bin in &order[1..] {
        if bin.count > top.count {
            top = bin;
        }
    }
    if top.count / (pixels.len() as f64) < 0.5 {
        let channel = |index: usize| mean(&pixels.iter().map(|entry| entry[index]).collect::<Vec<_>>());
        return [channel(0), channel(1), channel(2)];
    }
    [top.sum[0] / top.count, top.sum[1] / top.count, top.sum[2] / top.count]
}

fn quantile(sorted: &[f64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let last = (sorted.len() - 1) as f64;
    sorted[min(last, max(0.0, round(last * ratio))) as usize]
}

fn normalized_entropy(histogram: &[f64]) -> f64 {
    let total: f64 = histogram.iter().fold(0.0, |sum, count| sum + count);
    if total == 0.0 {
        return 0.0;
    }
    let raw = histogram.iter().fold(0.0, |sum, count| {
        if *count == 0.0 {
            return sum;
        }
        let probability = count / total;
        sum - probability * probability.log2()
    });
    raw / (histogram.len() as f64).log2()
}

fn colorfulness(reds: &[f64], greens: &[f64], blues: &[f64]) -> f64 {
    let red_green: Vec<f64> = reds.iter().zip(greens).map(|(red, green)| red - green).collect();
    let yellow_blue: Vec<f64> = reds.iter().zip(greens).zip(blues).map(|((red, green), blue)| (red + green) / 2.0 - blue).collect();
    let spread = deviation(&red_green);
    let spread_yb = deviation(&yellow_blue);
    let (centre_rg, centre_yb) = (mean(&red_green), mean(&yellow_blue));
    (spread * spread + spread_yb * spread_yb).sqrt() + 0.3 * (centre_rg * centre_rg + centre_yb * centre_yb).sqrt()
}

/// Similarity of two pages' 16x9 occupancy grids (1 = identical structure).
pub(crate) fn structure_similarity(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let distances: Vec<f64> = left.iter().zip(right).map(|(a, b)| (a - b).abs()).collect();
    clamp(1.0 - mean(&distances), 0.0, 1.0)
}

struct SpatialStats {
    coverage: f64,
    balance: f64,
    occupied_quadrants: usize,
}

fn structure_stats(structure: &[f64]) -> SpatialStats {
    if structure.is_empty() {
        return SpatialStats { coverage: 0.0, balance: 0.0, occupied_quadrants: 0 };
    }
    let active: Vec<f64> = structure.iter().map(|value| if *value >= 0.08 { 1.0 } else { 0.0 }).collect();
    let coverage = mean(&active);
    let (mut total, mut weighted_x, mut weighted_y) = (0.0, 0.0, 0.0);
    let mut quadrants = [0.0f64; 4];
    for (index, value) in structure.iter().enumerate() {
        let x = index % STRUCTURE_COLUMNS;
        let y = index / STRUCTURE_COLUMNS;
        total += value;
        weighted_x += value * ((x as f64 + 0.5) / STRUCTURE_COLUMNS as f64);
        weighted_y += value * ((y as f64 + 0.5) / STRUCTURE_ROWS as f64);
        let lower = if y as f64 >= STRUCTURE_ROWS as f64 / 2.0 { 2 } else { 0 };
        let right = if x as f64 >= STRUCTURE_COLUMNS as f64 / 2.0 { 1 } else { 0 };
        quadrants[lower + right] += value;
    }
    let center_x = if total != 0.0 { weighted_x / total } else { 0.5 };
    let center_y = if total != 0.0 { weighted_y / total } else { 0.5 };
    let balance = clamp(1.0 - ((center_x - 0.5).abs() + (center_y - 0.5).abs()) * 1.25, 0.0, 1.0);
    let occupied_quadrants = quadrants.iter().filter(|value| **value >= total * 0.08).count();
    SpatialStats { coverage, balance, occupied_quadrants }
}

fn hue_bin(red: f64, green: f64, blue: f64) -> usize {
    let maximum = max(max(red, green), blue);
    let minimum = min(min(red, green), blue);
    let range = maximum - minimum;
    if range == 0.0 {
        return 0;
    }
    let hue = if maximum == red {
        ((green - blue) / range) % 6.0
    } else if maximum == green {
        (blue - red) / range + 2.0
    } else {
        (red - green) / range + 4.0
    };
    let degrees = (hue * 60.0 + 360.0) % 360.0;
    min(11.0, (degrees / 30.0).floor()) as usize
}

/// Feature distance between two pages: what the rhythm review reads as change.
pub(crate) fn metric_distance(left: &PageMetric, right: &PageMetric) -> f64 {
    mean(&[
        (left.background_luminance - right.background_luminance).abs(),
        (left.colorfulness_score - right.colorfulness_score).abs(),
        (left.entropy - right.entropy).abs(),
        (left.edge_density - right.edge_density).abs(),
        (left.foreground_coverage - right.foreground_coverage).abs(),
    ])
}

/// The legibility of the marks themselves: the strongest decile of foreground luminance deltas, read at a
/// resolution where type strokes survive.
fn measure_ink_contrast(flattened: &mixdog_raster::Image, background_luminance: f64) -> f64 {
    let grey = greyscale(&resize_exact(flattened, INK_WIDTH, INK_HEIGHT, Kernel::Lanczos3));
    let mut deltas: Vec<f64> = Vec::new();
    for pixel in grey.rgba().chunks_exact(4) {
        let delta = (f64::from(pixel[0]) / 255.0 - background_luminance).abs();
        if delta >= INK_FOREGROUND {
            deltas.push(delta);
        }
    }
    deltas.sort_by(f64::total_cmp);
    quantile(&deltas, 0.9)
}

/// `renderedAestheticMetric(image, index)`: `None` for an image without data; an undecodable one is an error (sharp
/// rejected). `index` is the image's place in the list the review was given.
pub(crate) fn rendered_aesthetic_metric(image: &Value, index: usize) -> Result<Option<PageMetric>, String> {
    let Some(data) = field(image, "data").filter(|data| crate::is_truthy(Some(*data))) else {
        return Ok(None);
    };
    let flattened = decode_image(data)?.flatten([255, 255, 255]);
    let decoded = resize_exact(&flattened, SAMPLE_WIDTH as u32, SAMPLE_HEIGHT as u32, Kernel::Lanczos3);
    let pixels = decoded.rgba();
    let count = SAMPLE_WIDTH * SAMPLE_HEIGHT;
    let (mut reds, mut greens, mut blues, mut luminance) =
        (Vec::with_capacity(count), Vec::with_capacity(count), Vec::with_capacity(count), Vec::with_capacity(count));
    let mut histogram = [0.0f64; 16];
    let mut border: Vec<[f64; 3]> = Vec::new();
    for y in 0..SAMPLE_HEIGHT {
        for x in 0..SAMPLE_WIDTH {
            let offset = (y * SAMPLE_WIDTH + x) * 4;
            let (red, green, blue) = (f64::from(pixels[offset]), f64::from(pixels[offset + 1]), f64::from(pixels[offset + 2]));
            let light = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255.0;
            reds.push(red);
            greens.push(green);
            blues.push(blue);
            luminance.push(light);
            histogram[min(15.0, (light * 16.0).floor()) as usize] += 1.0;
            if x < 3 || y < 3 || x >= SAMPLE_WIDTH - 3 || y >= SAMPLE_HEIGHT - 3 {
                border.push([red, green, blue]);
            }
        }
    }
    // The page background is the border's dominant colour, not its mean: a field that reaches the edge would blend
    // into the estimate and read every mark as low contrast against a colour that exists nowhere on the page.
    let background = dominant_color(&border);
    let background_luminance = (0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2]) / 255.0;
    let mut occupancy = vec![0.0f64; STRUCTURE_COLUMNS * STRUCTURE_ROWS];
    let mut occupancy_samples = vec![0.0f64; occupancy.len()];
    let (mut foreground, mut foreground_luminance_delta) = (0.0f64, 0.0f64);
    let ink_contrast = measure_ink_contrast(&flattened, background_luminance);
    let mut colorful_foreground = 0.0f64;
    let mut hue_histogram = [0.0f64; 12];
    let (mut edges, mut edge_samples) = (0.0f64, 0.0f64);
    for y in 0..SAMPLE_HEIGHT {
        for x in 0..SAMPLE_WIDTH {
            let index = y * SAMPLE_WIDTH + x;
            let (red, green, blue) = (reds[index], greens[index], blues[index]);
            let distance = max(max((red - background[0]).abs(), (green - background[1]).abs()), (blue - background[2]).abs());
            let occupied = if distance >= 28.0 { 1.0 } else { 0.0 };
            foreground += occupied;
            if occupied != 0.0 {
                foreground_luminance_delta += (luminance[index] - background_luminance).abs();
                let channel_maximum = max(max(red, green), blue);
                let channel_minimum = min(min(red, green), blue);
                let saturation = if channel_maximum != 0.0 { (channel_maximum - channel_minimum) / channel_maximum } else { 0.0 };
                if saturation >= 0.22 {
                    colorful_foreground += 1.0;
                    hue_histogram[hue_bin(red, green, blue)] += 1.0;
                }
            }
            let cell_x = min(STRUCTURE_COLUMNS as f64 - 1.0, ((x as f64 / SAMPLE_WIDTH as f64) * STRUCTURE_COLUMNS as f64).floor()) as usize;
            let cell_y = min(STRUCTURE_ROWS as f64 - 1.0, ((y as f64 / SAMPLE_HEIGHT as f64) * STRUCTURE_ROWS as f64).floor()) as usize;
            let cell = cell_y * STRUCTURE_COLUMNS + cell_x;
            occupancy[cell] += occupied;
            occupancy_samples[cell] += 1.0;
            if x > 0 {
                edges += if (luminance[index] - luminance[index - 1]).abs() >= 0.12 { 1.0 } else { 0.0 };
                edge_samples += 1.0;
            }
            if y > 0 {
                edges += if (luminance[index] - luminance[index - SAMPLE_WIDTH]).abs() >= 0.12 { 1.0 } else { 0.0 };
                edge_samples += 1.0;
            }
        }
    }
    let mut sorted_luminance = luminance.clone();
    sorted_luminance.sort_by(f64::total_cmp);
    let raw_colorfulness = colorfulness(&reds, &greens, &blues);
    let structure: Vec<f64> =
        occupancy.iter().enumerate().map(|(cell, value)| if occupancy_samples[cell] != 0.0 { value / occupancy_samples[cell] } else { 0.0 }).collect();
    let spatial = structure_stats(&structure);
    let palette_threshold = max(3.0, colorful_foreground * 0.05);
    let palette_hue_count = hue_histogram.iter().filter(|count| **count >= palette_threshold).count();
    let palette_dominance =
        if colorful_foreground != 0.0 { hue_histogram.iter().fold(f64::NEG_INFINITY, |best, count| max(best, *count)) / colorful_foreground } else { 0.0 };
    let width = to_number_of(field(image, "width"));
    let height = to_number_of(field(image, "height"));
    // `Number(image.width) || decoded.info.width`: the fallback is the size of the resampled read.
    let or_decoded = |stated: f64, decoded: u32| if stated.is_nan() || stated == 0.0 { f64::from(decoded) } else { stated };
    Ok(Some(PageMetric {
        page: page_number(image, index),
        width: or_decoded(width, SAMPLE_WIDTH as u32),
        height: or_decoded(height, SAMPLE_HEIGHT as u32),
        background_luminance: rounded(background_luminance, 4),
        luminance_mean: rounded(mean(&luminance), 4),
        contrast_span: rounded(quantile(&sorted_luminance, 0.9) - quantile(&sorted_luminance, 0.1), 4),
        foreground_contrast: rounded(if foreground != 0.0 { foreground_luminance_delta / foreground } else { 0.0 }, 4),
        ink_contrast: rounded(ink_contrast, 4),
        colorfulness: rounded(raw_colorfulness, 2),
        colorfulness_score: rounded(clamp(raw_colorfulness / 45.0, 0.0, 1.0), 4),
        accent_coverage: rounded(if foreground != 0.0 { colorful_foreground / foreground } else { 0.0 }, 4),
        palette_hue_count,
        palette_dominance: rounded(palette_dominance, 4),
        entropy: rounded(normalized_entropy(&histogram), 4),
        edge_density: rounded(if edge_samples != 0.0 { edges / edge_samples } else { 0.0 }, 4),
        foreground_coverage: rounded(foreground / luminance.len() as f64, 4),
        spatial_coverage: rounded(spatial.coverage, 4),
        spatial_balance: rounded(spatial.balance, 4),
        occupied_quadrants: spatial.occupied_quadrants,
        structure,
    }))
}
