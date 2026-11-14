//! Whether a captured frame is usable: empty, mismatched or flat near-black or
//! near-white (observation/frame-quality.ts, shared/common.ts:33-42).

const SAMPLE_LIMIT: usize = 4096;
const CHROME_MARGIN: usize = 8;
const NEAR_BLACK: u8 = 4;
const NEAR_WHITE: u8 = 251;
const UNUSABLE_RATIO: f64 = 0.995;

/// Why a frame carries no usable pixels: a code the plan matches and its text.
#[derive(Debug, PartialEq)]
pub struct Issue {
    pub reason: &'static str,
    pub message: &'static str,
}

impl Issue {
    /// The refusal a capture failure carries (`reason: message`).
    pub fn text(&self) -> String {
        format!("{}: {}", self.reason, self.message)
    }
}

fn issue(reason: &'static str, message: &'static str) -> Option<Issue> {
    Some(Issue { reason, message })
}

/// The window's content area inside the frame, in frame pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Judges `pixels` (four bytes each; the colour channels are tested alike, so
/// their order does not matter) of a `width` x `height` frame against the
/// `expected` size of its target, sampling the interior of `content` (the whole
/// frame when None) so a window's border cannot make an empty frame look
/// usable (frameQualityIssue).
pub fn frame_quality_issue(
    pixels: &[u8],
    (width, height): (usize, usize),
    expected: (i32, i32),
    content: Option<Region>,
) -> Option<Issue> {
    if width == 0 || height == 0 || pixels.is_empty() {
        return issue("empty_frame", "capture returned an empty pixel frame");
    }
    let expected_ratio = f64::from(expected.0) / f64::from(expected.1.max(1));
    let actual_ratio = width as f64 / height as f64;
    let aspect_error = (actual_ratio - expected_ratio).abs() / expected_ratio.max(0.0001);
    if !aspect_error.is_finite() || aspect_error > 0.05 {
        return issue(
            "coordinate_mismatch",
            "capture dimensions do not match the target coordinate space",
        );
    }
    if pixels.len() / 4 == 0 {
        return issue("empty_frame", "capture returned no readable pixel data");
    }
    let region = content.unwrap_or(Region {
        x: 0,
        y: 0,
        width: width as i32,
        height: height as i32,
    });
    let fits = region.x >= 0
        && region.y >= 0
        && region.width > 0
        && region.height > 0
        && i64::from(region.x) + i64::from(region.width) <= width as i64
        && i64::from(region.y) + i64::from(region.height) <= height as i64;
    if !fits {
        return issue(
            "coordinate_mismatch",
            "window client bounds do not fit the captured surface",
        );
    }
    let (rx, ry) = (region.x as usize, region.y as usize);
    let (rw, rh) = (region.width as usize, region.height as usize);
    let margin = CHROME_MARGIN.min(rw.min(rh) / 8);
    let interior_width = rw.saturating_sub(margin * 2).max(1);
    let interior_height = rh.saturating_sub(margin * 2).max(1);
    let interior = interior_width * interior_height;
    let stride = (interior / SAMPLE_LIMIT).max(1);
    let (mut sampled, mut black, mut white) = (0usize, 0usize, 0usize);
    for pixel in (0..interior).step_by(stride) {
        let offset =
            ((ry + margin + pixel / interior_width) * width + rx + margin + pixel % interior_width)
                * 4;
        let channel = |at: usize| pixels.get(offset + at).copied().unwrap_or(0);
        let (blue, green, red) = (channel(0), channel(1), channel(2));
        sampled += 1;
        if red <= NEAR_BLACK && green <= NEAR_BLACK && blue <= NEAR_BLACK {
            black += 1;
        }
        if red >= NEAR_WHITE && green >= NEAR_WHITE && blue >= NEAR_WHITE {
            white += 1;
        }
    }
    let ratio = |count: usize| count as f64 / sampled.max(1) as f64;
    if ratio(black) >= UNUSABLE_RATIO {
        return issue(
            "blank_black_frame",
            "capture is effectively all black; no coordinate frame was issued",
        );
    }
    if ratio(white) >= UNUSABLE_RATIO {
        return issue(
            "blank_white_frame",
            "capture is effectively all white; no coordinate frame was issued",
        );
    }
    None
}

/// The judgment of a PNG frame: one that cannot be read is empty.
pub fn png_quality_issue(
    png: &[u8],
    expected: (i32, i32),
    content: Option<Region>,
) -> Option<Issue> {
    match decode_png(png) {
        Some((pixels, size)) => frame_quality_issue(&pixels, size, expected, content),
        None => issue("empty_frame", "capture returned no readable pixel data"),
    }
}

/// 8-bit RGBA pixels and the size of a PNG; Windows frames are always that.
#[cfg(windows)]
pub(super) fn decode_png(png: &[u8]) -> Option<(Vec<u8>, (usize, usize))> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().ok()?;
    let mut pixels = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut pixels).ok()?;
    let rgba = frame.color_type == png::ColorType::Rgba && frame.bit_depth == png::BitDepth::Eight;
    rgba.then(|| {
        pixels.truncate(frame.buffer_size());
        (pixels, (frame.width as usize, frame.height as usize))
    })
}

/// Only Windows produces window surfaces through this plan.
#[cfg(not(windows))]
pub(super) fn decode_png(_png: &[u8]) -> Option<(Vec<u8>, (usize, usize))> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(width: usize, height: usize, value: u8) -> Vec<u8> {
        vec![value; width * height * 4]
    }

    fn paint(pixels: &mut [u8], width: usize, x: usize, y: usize, value: u8) {
        let at = (y * width + x) * 4;
        pixels[at..at + 4].fill(value);
    }

    fn judge(pixels: &[u8], size: (usize, usize), content: Option<Region>) -> Option<&'static str> {
        frame_quality_issue(pixels, size, (size.0 as i32, size.1 as i32), content).map(|i| i.reason)
    }

    #[test]
    fn an_empty_frame_is_refused() {
        assert_eq!(judge(&[], (0, 0), None), Some("empty_frame"));
        assert_eq!(judge(&[], (4, 4), None), Some("empty_frame"));
        assert_eq!(judge(&[1, 2, 3, 4], (0, 1), None), Some("empty_frame"));
    }

    #[test]
    fn a_frame_off_the_target_aspect_is_a_coordinate_mismatch() {
        let pixels = flat(40, 20, 128);
        let reason = |expected| {
            frame_quality_issue(&pixels, (40, 20), expected, None).map(|issue| issue.reason)
        };
        assert_eq!(reason((20, 20)), Some("coordinate_mismatch"));
        // 4.8% off passes; 5.3% does not.
        assert_eq!(reason((42, 20)), None);
        assert_eq!(reason((38, 20)), Some("coordinate_mismatch"));
        // A zero-height target counts as one pixel tall instead of dividing by zero.
        assert_eq!(reason((40, 0)), Some("coordinate_mismatch"));
    }

    #[test]
    fn a_flat_frame_is_black_or_white() {
        assert_eq!(judge(&flat(64, 64, 0), (64, 64), None), Some("blank_black_frame"));
        assert_eq!(judge(&flat(64, 64, 4), (64, 64), None), Some("blank_black_frame"));
        assert_eq!(judge(&flat(64, 64, 251), (64, 64), None), Some("blank_white_frame"));
        assert_eq!(judge(&flat(64, 64, 128), (64, 64), None), None);
        assert_eq!(judge(&flat(64, 64, 5), (64, 64), None), None);
        assert_eq!(judge(&flat(64, 64, 250), (64, 64), None), None);
    }

    #[test]
    fn the_window_border_does_not_make_an_empty_frame_usable() {
        // A bright 8 px frame around black content: judged by the interior.
        let mut pixels = flat(64, 64, 255);
        for y in 8..56 {
            for x in 8..56 {
                paint(&mut pixels, 64, x, y, 0);
            }
        }
        assert_eq!(judge(&pixels, (64, 64), None), Some("blank_black_frame"));
    }

    #[test]
    fn a_little_content_keeps_the_frame_usable() {
        // One pixel per interior row is over 1% of the sample: above the tolerance.
        let mut pixels = flat(100, 100, 0);
        for y in 0..100 {
            paint(&mut pixels, 100, 50, y, 200);
        }
        assert_eq!(judge(&pixels, (100, 100), None), None);
        // A single pixel is within it.
        let mut sparse = flat(100, 100, 0);
        paint(&mut sparse, 100, 50, 50, 200);
        assert_eq!(judge(&sparse, (100, 100), None), Some("blank_black_frame"));
    }

    #[test]
    fn the_content_region_selects_what_is_sampled() {
        // Black on the left half, grey on the right.
        let mut pixels = flat(80, 40, 128);
        for y in 0..40 {
            for x in 0..40 {
                paint(&mut pixels, 80, x, y, 0);
            }
        }
        let region = |x, y, width, height| Some(Region { x, y, width, height });
        assert_eq!(
            judge(&pixels, (80, 40), region(0, 0, 40, 40)),
            Some("blank_black_frame")
        );
        assert_eq!(judge(&pixels, (80, 40), region(40, 0, 40, 40)), None);
        for bad in [region(41, 0, 40, 40), region(-1, 0, 10, 10), region(0, 0, 0, 10)] {
            assert_eq!(judge(&pixels, (80, 40), bad), Some("coordinate_mismatch"));
        }
    }

    #[test]
    fn a_tiny_frame_is_sampled_whole() {
        let mut pixels = flat(4, 4, 0);
        paint(&mut pixels, 4, 0, 0, 200);
        paint(&mut pixels, 4, 1, 0, 200);
        assert_eq!(judge(&pixels, (4, 4), None), None);
        assert_eq!(judge(&flat(1, 1, 0), (1, 1), None), Some("blank_black_frame"));
    }

    #[test]
    fn the_issue_reads_as_a_coded_refusal() {
        let issue = frame_quality_issue(&flat(8, 8, 0), (8, 8), (8, 8), None).expect("black");
        assert_eq!(
            issue.text(),
            "blank_black_frame: capture is effectively all black; no coordinate frame was issued"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_png_is_judged_by_its_pixels() {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 16, 16);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("header");
            writer.write_image_data(&flat(16, 16, 0)).expect("data");
        }
        let issue = png_quality_issue(&bytes, (16, 16), None);
        assert_eq!(issue.map(|i| i.reason), Some("blank_black_frame"));
        let unreadable = png_quality_issue(b"not a png", (16, 16), None);
        assert_eq!(unreadable.map(|i| i.reason), Some("empty_frame"));
    }
}
