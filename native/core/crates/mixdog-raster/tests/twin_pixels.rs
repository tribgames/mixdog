//! The shared picture rule of the pixel twins (`mixdog_office_base::twin::pixels`) judged on recorded images: it must let through the
//! difference of the measured kind (single pixels along an edge, anti-aliased differently by another rasteriser) and must not let
//! through a defect. Each defect is built from an image Node recorded (a page of `office-render-core`, the Latin text of
//! `office-canvas`): one glyph-sized rectangle blanked, a shape moved by 3 pixels, one colour changed by 40, a blank copy.

use mixdog_office_base::twin;
use mixdog_office_base::twin::pixels::{self, Picture};
use mixdog_raster::Image;

/// A recorded image: its name, size and straight RGBA.
struct Recorded {
    name: String,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl Recorded {
    fn picture(&self) -> Picture<'_> {
        Picture::new(self.width, self.height, &self.rgba)
    }

    fn with(&self, rgba: Vec<u8>) -> Recorded {
        Recorded { name: self.name.clone(), width: self.width, height: self.height, rgba }
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
}

/// Every render of the recorded pages of `office-render-core` and the recorded text of `office-canvas`.
fn recorded_images() -> Vec<Recorded> {
    let mut out = Vec::new();
    let core = twin::load_golden("office-render-core");
    for case in core["cases"].as_array().expect("cases") {
        for render in case["renders"].as_array().expect("renders") {
            let image = Image::decode(&unhex(render["png"].as_str().expect("png"))).expect("a recorded PNG");
            out.push(Recorded { name: format!("{} at {}", case["name"].as_str().expect("name"), render["scale"]), width: image.width(), height: image.height(), rgba: image.rgba().to_vec() });
        }
    }
    let canvas = twin::load_golden("office-canvas");
    for case in canvas["cases"].as_array().expect("cases") {
        if case["id"].as_str().is_some_and(|id| id.starts_with("text_")) {
            out.push(Recorded {
                name: format!("canvas {}", case["id"].as_str().expect("id")),
                width: case["width"].as_u64().expect("width") as u32,
                height: case["height"].as_u64().expect("height") as u32,
                rgba: twin::base64_decode(case["rgba"].as_str().expect("rgba")),
            });
        }
    }
    assert!(out.len() > 20, "the recording holds {} images", out.len());
    out
}

fn named<'a>(images: &'a [Recorded], name: &str) -> &'a Recorded {
    images.iter().find(|image| image.name == name).unwrap_or_else(|| panic!("no recorded image {name}"))
}

fn pixel(image: &Recorded, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * image.width + x) * 4) as usize;
    [image.rgba[at], image.rgba[at + 1], image.rgba[at + 2], image.rgba[at + 3]]
}

/// The colour of the top-left pixel: the page's background.
fn background(image: &Recorded) -> [u8; 4] {
    pixel(image, 0, 0)
}

fn ink_of(pixel: [u8; 4], background: [u8; 4]) -> u32 {
    (0..4).map(|channel| u32::from(pixel[channel].abs_diff(background[channel]))).sum()
}

/// The window of `width` x `height` pixels, laid at a multiple of `step`, that holds the most ink (distance from the background).
fn densest_window(image: &Recorded, width: u32, height: u32) -> (u32, u32) {
    let background = background(image);
    let (mut best, mut at) = (0u64, (0, 0));
    for y in (0..=image.height.saturating_sub(height)).step_by(2) {
        for x in (0..=image.width.saturating_sub(width)).step_by(2) {
            let mut ink = 0u64;
            for yy in y..y + height {
                for xx in x..x + width {
                    ink += u64::from(ink_of(pixel(image, xx, yy), background));
                }
            }
            if ink > best {
                (best, at) = (ink, (x, y));
            }
        }
    }
    assert!(best > 0, "{}: no ink", image.name);
    at
}

fn set(rgba: &mut [u8], image: &Recorded, x: u32, y: u32, value: [u8; 4]) {
    let at = ((y * image.width + x) * 4) as usize;
    rgba[at..at + 4].copy_from_slice(&value);
}

/// A glyph-sized rectangle (8 by 10 pixels) at the densest place, painted with the background.
fn blank_glyph(image: &Recorded) -> Recorded {
    let (x0, y0) = densest_window(image, 8, 10);
    let background = background(image);
    let mut rgba = image.rgba.clone();
    for y in y0..y0 + 10 {
        for x in x0..x0 + 8 {
            set(&mut rgba, image, x, y, background);
        }
    }
    image.with(rgba)
}

/// The densest 32 by 32 window with its content moved 3 pixels to the right (the three columns it leaves are the background).
fn move_shape(image: &Recorded) -> Recorded {
    let (x0, y0) = densest_window(image, 32, 32);
    let background = background(image);
    let mut rgba = image.rgba.clone();
    for y in y0..y0 + 32 {
        for x in (x0..x0 + 32).rev() {
            let value = if x >= x0 + 3 { pixel(image, x - 3, y) } else { background };
            set(&mut rgba, image, x, y, value);
        }
    }
    image.with(rgba)
}

/// The most frequent colour that is not the background, in every pixel that has it, 40 away in the red channel.
fn change_colour(image: &Recorded) -> Recorded {
    let background = background(image);
    let mut counts: std::collections::BTreeMap<[u8; 4], usize> = std::collections::BTreeMap::new();
    for chunk in image.rgba.chunks_exact(4) {
        let colour = [chunk[0], chunk[1], chunk[2], chunk[3]];
        if colour != background {
            *counts.entry(colour).or_default() += 1;
        }
    }
    let (colour, _) = counts.into_iter().max_by_key(|(_, count)| *count).expect("a colour besides the background");
    let mut rgba = image.rgba.clone();
    for chunk in rgba.chunks_exact_mut(4) {
        if chunk == colour {
            chunk[0] = if chunk[0] <= 215 { chunk[0] + 40 } else { chunk[0] - 40 };
        }
    }
    image.with(rgba)
}

fn blank(image: &Recorded) -> Recorded {
    image.with(image.rgba.chunks_exact(4).flat_map(|_| [255, 255, 255, 255]).collect())
}

/// Edge noise of the measured kind: a pixel whose neighbour to the right or below differs by more than 16 in some channel is an edge
/// pixel; one edge pixel in `every` is moved by 16 to 82 levels (up or down, in every colour channel together), as another
/// rasteriser's coverage of the edge would move it. Nothing else changes.
fn edge_noise(image: &Recorded, every: u32) -> Recorded {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut rgba = image.rgba.clone();
    for y in 0..image.height {
        for x in 0..image.width {
            let here = pixel(image, x, y);
            let differs = |other: [u8; 4]| (0..3).any(|channel| here[channel].abs_diff(other[channel]) > 16);
            let edge = (x + 1 < image.width && differs(pixel(image, x + 1, y))) || (y + 1 < image.height && differs(pixel(image, x, y + 1)));
            if edge && next() % u64::from(every) == 0 {
                let step = 16 + (next() % 67) as i32;
                let signed = if next() % 2 == 0 { step } else { -step };
                let mut moved = here;
                for channel in &mut moved[..3] {
                    *channel = (i32::from(*channel) + signed).clamp(0, 255) as u8;
                }
                set(&mut rgba, image, x, y, moved);
            }
        }
    }
    image.with(rgba)
}

fn measure(ours: &Recorded, theirs: &Recorded) -> pixels::Comparison {
    pixels::compare(ours.picture(), theirs.picture())
}

#[test]
fn a_recorded_image_is_the_same_picture_as_itself() {
    for image in recorded_images() {
        let comparison = measure(&image, &image);
        assert_eq!(comparison.verdict(), Ok(()), "{}", image.name);
        assert_eq!((comparison.mean, comparison.largest_block), (0.0, 0.0), "{}", image.name);
    }
}

#[test]
fn one_glyph_sized_rectangle_blanked_is_not_the_same_picture() {
    let images = recorded_images();
    for name in ["canvas text_latin", "strokes at 2", "fills at 2", "image-xobjects at 2"] {
        let image = named(&images, name);
        let defect = blank_glyph(image);
        let comparison = measure(&defect, image);
        eprintln!("{name}: glyph blanked: {}", comparison.summary());
        assert!(comparison.verdict().is_err(), "{name}: a blanked glyph-sized rectangle passes ({})", comparison.summary());
        assert!(comparison.mean < pixels::MEAN_LIMIT, "{name}: the mean alone would not have caught it, so the block rule is what does ({})", comparison.summary());
    }
}

#[test]
fn a_shape_moved_by_three_pixels_is_not_the_same_picture() {
    let images = recorded_images();
    for name in ["strokes at 2", "fills at 2", "image-xobjects at 2", "clipping at 2"] {
        let image = named(&images, name);
        let defect = move_shape(image);
        let comparison = measure(&defect, image);
        eprintln!("{name}: shape moved by 3: {}", comparison.summary());
        assert!(comparison.verdict().is_err(), "{name}: a shape moved by 3 pixels passes ({})", comparison.summary());
    }
}

#[test]
fn one_colour_changed_by_forty_is_not_the_same_picture() {
    let images = recorded_images();
    for name in ["fills at 2", "image-xobjects at 2", "clipping at 2"] {
        let image = named(&images, name);
        let defect = change_colour(image);
        let comparison = measure(&defect, image);
        eprintln!("{name}: colour changed by 40: {}", comparison.summary());
        assert!(comparison.verdict().is_err(), "{name}: a colour changed by 40 passes ({})", comparison.summary());
    }
}

#[test]
fn a_blank_copy_is_not_the_same_picture() {
    for image in recorded_images() {
        let defect = blank(&image);
        let comparison = measure(&defect, &image);
        // A recorded page that is itself white all over cannot be told from a blank one.
        if image.rgba.chunks_exact(4).all(|pixel| pixel == [255, 255, 255, 255]) {
            continue;
        }
        assert!(comparison.verdict().is_err(), "{}: a blank copy passes ({})", image.name, comparison.summary());
    }
}

#[test]
fn a_different_size_is_not_the_same_picture() {
    let images = recorded_images();
    let image = named(&images, "fills at 2");
    let narrower: Vec<u8> = (0..image.height).flat_map(|y| (0..image.width - 1).flat_map(move |x| [x as u8, y as u8, 0, 255])).collect();
    let other = Picture::new(image.width - 1, image.height, &narrower);
    assert!(pixels::compare(other, image.picture()).verdict().is_err_and(|why| why.contains("sizes differ")));
}

#[test]
fn edge_noise_of_the_measured_kind_is_the_same_picture() {
    // The measured kind: a mean under 0.74 of 255 (the largest mean measured between the Rust rasterisers and Node's) with single edge
    // pixels 16 to 82 away. For each image the noise is made as dense as that mean allows: one edge pixel in `every` is moved, `every`
    // the smallest from 6 on whose mean is at most 0.7.
    let images = recorded_images();
    let mut seen_large_pixel = false;
    for image in &images {
        let (noisy, comparison) = (6..400)
            .map(|every| {
                let noisy = edge_noise(image, every);
                let comparison = measure(&noisy, image);
                (noisy, comparison)
            })
            .find(|(_, comparison)| comparison.mean <= 0.7)
            .unwrap_or_else(|| panic!("{}: no edge noise of the measured kind", image.name));
        let _ = noisy;
        eprintln!("{}: edge noise: {}", image.name, comparison.summary());
        seen_large_pixel |= comparison.largest_pixel >= 60;
        assert_eq!(comparison.verdict(), Ok(()), "{}: edge noise is refused ({})", image.name, comparison.summary());
    }
    assert!(seen_large_pixel, "no recorded image had an edge pixel moved by 60 or more");
}

/// The rule for numbers: 0.0117 apart passes, 0.0234 does not.
#[test]
fn a_pixel_measure_has_a_tolerance_of_two_hundredths() {
    let mut found = Vec::new();
    pixels::measure_differences("", &serde_json::json!({"score": 0.7062}), &serde_json::json!({"score": 0.7179}), &mut found);
    assert!(found.is_empty(), "{found:?}");
    pixels::measure_differences("", &serde_json::json!({"score": 0.7062}), &serde_json::json!({"score": 0.7296}), &mut found);
    assert_eq!(found.len(), 1);
}
