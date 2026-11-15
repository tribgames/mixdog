//! How the twin tests compare a rendered picture, and a number computed from rendered pixels, with what Node's engines drew
//! and measured. One rule, owner-approved (2026-11-16), shared by every pixel twin (`mixdog-pdf` render_core and render_paint,
//! `mixdog-office-pdf` render_pages, `mixdog-raster` canvas and svg, `mixdog-office-quality` rendered, `mixdog-office` e2e).
//!
//! The Rust rasterisers (tiny-skia, resvg, the PDF painter, the resize) anti-alias the edge of a glyph or a shape a little
//! differently from the engines Node used (Skia through `@napi-rs/canvas`, libvips through sharp, pdf.js on that canvas),
//! so single edge pixels differ by tens of levels while the picture is the same. Two images are **the same picture** when
//!
//! 1. their sizes are equal;
//! 2. the mean absolute difference per channel over the whole image (every channel of every pixel, alpha included) is at most
//!    [`MEAN_LIMIT`] of 255;
//! 3. after both are reduced by a box filter, no channel of any block differs by more than [`BLOCK_LIMIT`]. The filter is
//!    the exact average of every [`BLOCK`] by [`BLOCK`] block of pixels, the blocks laid from the top-left corner with no
//!    overlap. At the right and the bottom edge, where the size is not a multiple of [`BLOCK`], the last blocks are narrower
//!    or shorter and average the pixels they have (their own count, not padded): no pixel is dropped, none invented. The
//!    averages are not rounded (the sums of the two images are compared as integers before the division).
//!
//! An anti-aliasing difference of a pixel or two along an edge disappears in the block average; a missing glyph, a moved
//! shape, a wrong colour or a blank page does not (`mixdog-raster/tests/twin_pixels.rs` builds each defect from a recorded
//! image).
//!
//! Numbers that are functions of the rendered pixels (the aesthetics score and its dimensions, the ink and the air, the
//! shares of a page that holds ink) agree within [`MEASURE_TOLERANCE`] absolute; every other number, text, verdict, count and
//! issue is compared exactly ([`measure_differences`], [`measures_match_in_text`]).

use serde_json::Value;

/// Rule 2: the mean absolute difference per channel, of 255.
pub const MEAN_LIMIT: f64 = 1.0;
/// Rule 3: the side of a block of the box filter, in pixels.
pub const BLOCK: usize = 4;
/// Rule 3: the largest difference of any channel of any block average, of 255.
pub const BLOCK_LIMIT: f64 = 24.0;
/// The absolute difference two numbers computed from rendered pixels may have.
pub const MEASURE_TOLERANCE: f64 = 0.02;

/// A picture: 8-bit RGBA, rows top to bottom, `width * height * 4` bytes.
#[derive(Clone, Copy)]
pub struct Picture<'a> {
    pub width: u32,
    pub height: u32,
    pub rgba: &'a [u8],
}

impl<'a> Picture<'a> {
    pub fn new(width: u32, height: u32, rgba: &'a [u8]) -> Self {
        assert_eq!(rgba.len(), width as usize * height as usize * 4, "{width}x{height} is not {} bytes of RGBA", rgba.len());
        Self { width, height, rgba }
    }
}

/// What the rule measured between two pictures.
#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    /// Both sizes when they differ (nothing else is measured then).
    pub sizes: Option<((u32, u32), (u32, u32))>,
    /// Rule 2: the mean absolute difference per channel.
    pub mean: f64,
    /// The largest difference of a single channel of a single pixel (reported, not judged).
    pub largest_pixel: u8,
    /// Rule 3: the largest difference of a channel of a block average.
    pub largest_block: f64,
    /// Where it is: the top-left pixel of the block and the channel (0 red, 1 green, 2 blue, 3 alpha).
    pub worst_block: (u32, u32, usize),
}

impl Comparison {
    /// `Ok` when the pictures are the same picture; else why not, with the numbers.
    pub fn verdict(&self) -> Result<(), String> {
        if let Some((ours, theirs)) = self.sizes {
            return Err(format!("the sizes differ: {}x{} here, {}x{} recorded", ours.0, ours.1, theirs.0, theirs.1));
        }
        let mut why = Vec::new();
        if self.mean > MEAN_LIMIT {
            why.push(format!("mean difference {:.4} per channel (at most {MEAN_LIMIT})", self.mean));
        }
        if self.largest_block > BLOCK_LIMIT {
            let (x, y, channel) = self.worst_block;
            why.push(format!("a {BLOCK}x{BLOCK} block at ({x}, {y}) differs by {:.2} in channel {channel} (at most {BLOCK_LIMIT})", self.largest_block));
        }
        if why.is_empty() { Ok(()) } else { Err(why.join("; ")) }
    }

    /// One line for the log of a calibration run: the numbers of the rule and the largest single pixel.
    pub fn summary(&self) -> String {
        match self.sizes {
            Some((ours, theirs)) => format!("sizes {}x{} against {}x{}", ours.0, ours.1, theirs.0, theirs.1),
            None => format!("mean {:.4}, largest {BLOCK}x{BLOCK} block {:.2}, largest pixel {}", self.mean, self.largest_block, self.largest_pixel),
        }
    }
}

/// Measures `ours` against `theirs` by the rule.
pub fn compare(ours: Picture<'_>, theirs: Picture<'_>) -> Comparison {
    if (ours.width, ours.height) != (theirs.width, theirs.height) {
        return Comparison {
            sizes: Some(((ours.width, ours.height), (theirs.width, theirs.height))),
            mean: 0.0,
            largest_pixel: 0,
            largest_block: 0.0,
            worst_block: (0, 0, 0),
        };
    }
    let (width, height) = (ours.width as usize, ours.height as usize);
    let (mut sum, mut largest_pixel) = (0u64, 0u8);
    for (a, b) in ours.rgba.iter().zip(theirs.rgba) {
        let d = a.abs_diff(*b);
        largest_pixel = largest_pixel.max(d);
        sum += u64::from(d);
    }
    let mean = sum as f64 / ours.rgba.len().max(1) as f64;
    let (mut largest_block, mut worst_block) = (0.0f64, (0u32, 0u32, 0usize));
    for top in (0..height).step_by(BLOCK) {
        let rows = BLOCK.min(height - top);
        for left in (0..width).step_by(BLOCK) {
            let columns = BLOCK.min(width - left);
            let (mut mine, mut yours) = ([0i64; 4], [0i64; 4]);
            for y in top..top + rows {
                let start = (y * width + left) * 4;
                let end = start + columns * 4;
                for (offset, (a, b)) in ours.rgba[start..end].iter().zip(&theirs.rgba[start..end]).enumerate() {
                    mine[offset % 4] += i64::from(*a);
                    yours[offset % 4] += i64::from(*b);
                }
            }
            let pixels = (rows * columns) as f64;
            for channel in 0..4 {
                let step = (mine[channel] - yours[channel]).unsigned_abs() as f64 / pixels;
                if step > largest_block {
                    largest_block = step;
                    worst_block = (left as u32, top as u32, channel);
                }
            }
        }
    }
    Comparison { sizes: None, mean, largest_pixel, largest_block, worst_block }
}

/// `compare` and `verdict` in one: the comparison when the pictures are the same picture, else why not.
pub fn same_picture(ours: Picture<'_>, theirs: Picture<'_>) -> Result<Comparison, String> {
    let comparison = compare(ours, theirs);
    match comparison.verdict() {
        Ok(()) => Ok(comparison),
        Err(why) => Err(format!("{why}; {}", comparison.summary())),
    }
}

/// Straight RGBA made premultiplied (`channel * alpha / 255`, rounded), alpha kept: what a comparison of renders over a
/// transparent background should look at, since the colour of a fully transparent pixel is nothing.
pub fn premultiplied(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|pixel| {
            let alpha = u32::from(pixel[3]);
            let scaled = |channel: u8| ((u32::from(channel) * alpha + 127) / 255) as u8;
            [scaled(pixel[0]), scaled(pixel[1]), scaled(pixel[2]), pixel[3]]
        })
        .collect()
}

/// The names of the numbers an aesthetic or render review computes from the pixels of a page (or of its resize): the page
/// metric (`backgroundLuminance` to `spatialBalance` and the three scores computed from them), the ink shares of a page, the
/// score and the four dimensions, the rhythm's three spreads, the air and its balance and the changed share of a diff. A
/// count (`paletteHueCount`, `occupiedQuadrants`, `repeatedPairs`, `pageCount`), a page number, a size, the confidence
/// and `scoreVersion` are not here: they stay exact.
const MEASURE_KEYS: &[&str] = &[
    "backgroundLuminance",
    "luminanceMean",
    "contrastSpan",
    "foregroundContrast",
    "inkContrast",
    "colorfulness",
    "colorfulnessScore",
    "accentCoverage",
    "paletteDominance",
    "entropy",
    "edgeDensity",
    "foregroundCoverage",
    "spatialCoverage",
    "spatialBalance",
    "densityFit",
    "paletteDiscipline",
    "compositionScore",
    "score",
    "contrast",
    "palette",
    "rhythm",
    "composition",
    "featureSpread",
    "adjacentChange",
    "maximumSimilarity",
    "inkCoverage",
    "horizontalSpan",
    "verticalSpan",
    "bodyVerticalSpan",
    "bodyEnd",
    "lowerBodyInkRatio",
    "leftMargin",
    "rightMargin",
    "air",
    "centered",
    "leftRight",
    "topBottom",
    "colour",
    "largest",
    "changedPercent",
    // `quality.dimensions.render` of an answer: the aesthetic score of the rendered pages, carried into the quality summary.
    "render",
];

/// Whether the number at the object key `key` is computed from rendered pixels.
pub fn is_pixel_measure(key: &str) -> bool {
    MEASURE_KEYS.contains(&key)
}

fn last_key(path: &str) -> &str {
    let tail = path.rsplit('.').next().unwrap_or(path);
    tail.split('[').next().unwrap_or(tail)
}

/// Where two reviews differ, as lines. A number under a key of [`MEASURE_KEYS`] may differ by [`MEASURE_TOLERANCE`]; every
/// other value must be equal (numbers exactly), and the keys of an object must be the same keys in the same order. `path`
/// starts the lines (`""` for the root).
pub fn measure_differences(path: &str, expected: &Value, actual: &Value, found: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Number(want), Value::Number(got)) => {
            let (want, got) = (want.as_f64().unwrap_or(f64::NAN), got.as_f64().unwrap_or(f64::NAN));
            let measure = is_pixel_measure(last_key(path));
            // The numbers are rounded to four digits: a hair of float noise on the edge of the tolerance is not a difference.
            let agrees = if measure { (want - got).abs() <= MEASURE_TOLERANCE + 1e-9 } else { want == got };
            if !agrees {
                let note = if measure { format!(" (a pixel measure: more than {MEASURE_TOLERANCE} apart)") } else { String::new() };
                found.push(format!("{path}: recorded {want} produced {got}{note}"));
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                found.push(format!("{path}: recorded {} entries produced {}", want.len(), got.len()));
                return;
            }
            for (index, (want, got)) in want.iter().zip(got).enumerate() {
                measure_differences(&format!("{path}[{index}]"), want, got, found);
            }
        }
        (Value::Object(want), Value::Object(got)) => {
            let (want_keys, got_keys): (Vec<_>, Vec<_>) = (want.keys().collect(), got.keys().collect());
            if want_keys != got_keys {
                found.push(format!("{path}: recorded keys {want_keys:?} produced {got_keys:?}"));
                return;
            }
            for (key, want) in want {
                measure_differences(&format!("{path}.{key}"), want, &got[key], found);
            }
        }
        _ => {
            if expected != actual {
                let cut = |value: &Value| value.to_string().chars().take(160).collect::<String>();
                found.push(format!("{path}: recorded {} produced {}", cut(expected), cut(actual)));
            }
        }
    }
}

/// The text of an answer with the numbers of the pixel measures inside every `"aesthetics":{...}` and `"quality":{...}` object (the
/// quality summary of an answer carries the render score and a score computed from it) cut out: what
/// is left (every key, every other value, the order, the punctuation) and the cut numbers in order.
fn without_measures(text: &str) -> (String, Vec<f64>) {
    let chars: Vec<char> = text.chars().collect();
    let (mut skeleton, mut numbers) = (String::new(), Vec::new());
    let (mut depth, mut span) = (0usize, None::<usize>);
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match c {
            '"' => {
                let mut end = at + 1;
                while end < chars.len() && chars[end] != '"' {
                    end += if chars[end] == '\\' { 2 } else { 1 };
                }
                let end = (end + 1).min(chars.len());
                let literal: String = chars[at..end].iter().collect();
                skeleton.push_str(&literal);
                let key = literal.trim_matches('"');
                if end < chars.len() && chars[end] == ':' {
                    skeleton.push(':');
                    let value = end + 1;
                    if (key == "aesthetics" || key == "quality") && chars.get(value) == Some(&'{') && span.is_none() {
                        span = Some(depth + 1);
                    } else if span.is_some() && is_pixel_measure(key) && chars.get(value).is_some_and(|c| c.is_ascii_digit() || *c == '-') {
                        let mut stop = value;
                        while stop < chars.len() && matches!(chars[stop], '0'..='9' | '.' | '-' | '+' | 'e' | 'E') {
                            stop += 1;
                        }
                        let number: String = chars[value..stop].iter().collect();
                        if let Ok(number) = number.parse::<f64>() {
                            numbers.push(number);
                            skeleton.push_str("<n>");
                            at = stop;
                            continue;
                        }
                    }
                    at = end + 1;
                    continue;
                }
                at = end;
                continue;
            }
            '{' | '[' => {
                depth += 1;
                skeleton.push(c);
            }
            '}' | ']' => {
                if span == Some(depth) {
                    span = None;
                }
                depth = depth.saturating_sub(1);
                skeleton.push(c);
            }
            _ => skeleton.push(c),
        }
        at += 1;
    }
    (skeleton, numbers)
}

/// Whether two answer texts are the same but for the pixel measures of their `"aesthetics"` and `"quality"` objects, which agree within
/// [`MEASURE_TOLERANCE`]. `Err` names the first thing that differs.
pub fn measures_match_in_text(recorded: &str, produced: &str) -> Result<(), String> {
    let ((want, want_numbers), (got, got_numbers)) = (without_measures(recorded), without_measures(produced));
    if want != got {
        let at = want.chars().zip(got.chars()).position(|(a, b)| a != b).unwrap_or_else(|| want.chars().count().min(got.chars().count()));
        let around = |text: &str| text.chars().skip(at.saturating_sub(80)).take(200).collect::<String>();
        return Err(format!("the text differs outside the pixel measures at character {at}:\n    recorded: {}\n    produced: {}", around(&want), around(&got)));
    }
    for (index, (a, b)) in want_numbers.iter().zip(&got_numbers).enumerate() {
        if (a - b).abs() > MEASURE_TOLERANCE + 1e-9 {
            return Err(format!("pixel measure {index} of the aesthetics is {b} here, {a} recorded (more than {MEASURE_TOLERANCE} apart)"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn grey(width: u32, height: u32, value: u8) -> Vec<u8> {
        (0..width * height).flat_map(|_| [value, value, value, 255]).collect()
    }

    #[test]
    fn equal_pictures_are_the_same_and_sizes_are_compared_first() {
        let a = grey(10, 6, 200);
        let comparison = same_picture(Picture::new(10, 6, &a), Picture::new(10, 6, &a)).expect("same");
        assert_eq!((comparison.mean, comparison.largest_block, comparison.largest_pixel), (0.0, 0.0, 0));
        let b = grey(6, 10, 200);
        assert!(same_picture(Picture::new(10, 6, &a), Picture::new(6, 10, &b)).is_err_and(|why| why.contains("sizes differ")));
    }

    #[test]
    fn the_edge_blocks_average_the_pixels_they_have() {
        // 5x5: the right column and the bottom row are blocks of 1x4, 4x1 and 1x1 pixels.
        let a = grey(5, 5, 100);
        let mut b = a.clone();
        b[(4 * 5 + 4) * 4] = 200; // the 1x1 corner block: a step of 100 in one channel is the block's average
        let comparison = compare(Picture::new(5, 5, &a), Picture::new(5, 5, &b));
        assert_eq!(comparison.largest_block, 100.0);
        assert_eq!(comparison.worst_block, (4, 4, 0));
        // The same step in a full block is a sixteenth of it.
        let mut c = a.clone();
        c[0] = 200;
        assert_eq!(compare(Picture::new(5, 5, &a), Picture::new(5, 5, &c)).largest_block, 100.0 / 16.0);
    }

    #[test]
    fn the_two_limits_judge_separately() {
        let a = grey(16, 16, 128);
        // A mean over 1 with no block over 24: every channel 2 away.
        let near = grey(16, 16, 130);
        let comparison = compare(Picture::new(16, 16, &a), Picture::new(16, 16, &near));
        assert!(comparison.verdict().is_err_and(|why| why.contains("mean difference") && !why.contains("block")));
        // A block over 24 with a mean under 1: one 4x4 block 40 away in a 64x64 picture.
        let big = grey(64, 64, 128);
        let mut moved = big.clone();
        for y in 0..4 {
            for x in 0..4 {
                moved[(y * 64 + x) * 4] = 168;
            }
        }
        let comparison = compare(Picture::new(64, 64, &big), Picture::new(64, 64, &moved));
        assert!(comparison.mean < MEAN_LIMIT);
        assert!(comparison.verdict().is_err_and(|why| why.contains("block at (0, 0)") && why.contains("40.00")));
    }

    #[test]
    fn measures_are_tolerated_and_nothing_else_is() {
        let recorded = json!({ "aesthetics": { "score": 0.7062, "confidence": 1, "dimensions": { "composition": 0.3326 }, "pages": [{ "page": 1, "inkContrast": 0.8459, "paletteHueCount": 3 }] }, "issues": [] });
        let near = json!({ "aesthetics": { "score": 0.7031, "confidence": 1, "dimensions": { "composition": 0.3223 }, "pages": [{ "page": 1, "inkContrast": 0.8576, "paletteHueCount": 3 }] }, "issues": [] });
        let mut found = Vec::new();
        measure_differences("", &recorded, &near, &mut found);
        // 0.3326 against 0.3223 is 0.0103 and 0.8459 against 0.8576 is 0.0117: both inside 0.02.
        assert!(found.is_empty(), "{found:?}");
        let mut far = near.clone();
        far["aesthetics"]["score"] = json!(0.7300);
        far["aesthetics"]["confidence"] = json!(0.9999);
        far["aesthetics"]["pages"][0]["paletteHueCount"] = json!(4);
        far["issues"] = json!([{ "code": "x" }]);
        let mut found = Vec::new();
        measure_differences("", &recorded, &far, &mut found);
        assert_eq!(found.len(), 4, "{found:?}");
    }

    #[test]
    fn an_answer_text_differs_only_in_the_measures_of_its_aesthetics() {
        let recorded = r#"{"issues":[],"aesthetics":{"ok":true,"score":0.7062,"confidence":1,"dimensions":{"contrast":1,"composition":0.3326},"pages":[{"page":1,"entropy":0.5,"role":"opening"}]},"score":3}"#;
        let produced = r#"{"issues":[],"aesthetics":{"ok":true,"score":0.7031,"confidence":1,"dimensions":{"contrast":1,"composition":0.3223},"pages":[{"page":1,"entropy":0.51,"role":"opening"}]},"score":3}"#;
        assert_eq!(measures_match_in_text(recorded, produced), Ok(()));
        // Outside the aesthetics a number is exact.
        assert!(measures_match_in_text(recorded, &produced.replace(r#""score":3}"#, r#""score":4}"#)).is_err());
        // A measure too far, a changed word, a changed count and a changed key all differ.
        assert!(measures_match_in_text(recorded, &produced.replace("0.7031", "0.7500")).is_err());
        assert!(measures_match_in_text(recorded, &produced.replace("opening", "closing")).is_err());
        assert!(measures_match_in_text(recorded, &produced.replace(r#""confidence":1"#, r#""confidence":0.5"#)).is_err());
        assert!(measures_match_in_text(recorded, &produced.replace("entropy", "entrop")).is_err());
    }
}
