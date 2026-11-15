//! AVIF and HEIF inputs against what sharp (libvips with libheif) answered to the same bytes
//! (`avif-reference.json`, recorded by `record-avif-extras.mjs`): the `irot`, `imir` and `clap` properties and the
//! `colr` boxes of the primary item, an ICC profile, an HEIC (HEVC) file, corrupt files, and the AVIF that a resize
//! writes back.
//!
//! A decode is compared pixel by pixel with sharp's raw RGBA (a transformation applied wrongly moves every pixel,
//! which is far beyond the tolerance; colour conversion rounds differently by a level or two). A failure is compared
//! by class and by the libheif sentence it carries: the first line of sharp's text is a `source: bad seek` line of
//! its reader, which has no counterpart here, so the `heif:` line is what is compared. An encoder cannot be byte
//! equal: a resized AVIF is compared by its dimensions, mime, alpha and the decoded pixel content within the
//! tolerance the main corpus states for lossy outputs (a 32x32 area-averaged thumbnail at PSNR 38 dB or better and a
//! mean absolute difference of 2.0 or less).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_imaging::DECODE_PIXEL_LIMIT;
use mixdog_imaging::ErrorClass;
use mixdog_imaging::ResizeOptions;
use mixdog_imaging::decode;
use mixdog_imaging::probe;
use mixdog_imaging::resize_image_buffer;
use serde_json::Value;

const THUMB: usize = 32;
const MIN_PSNR: f64 = 38.0;
const MAX_MEAN_ABSOLUTE_DIFFERENCE: f64 = 2.0;
/// Raw decodes differ from libheif's by the rounding of the YCbCr conversion and of the sRGB conversion of an ICC
/// profile.
const MAX_DECODE_MEAN_DIFFERENCE: f64 = 3.0;

fn rows() -> Vec<Value> {
    let reference: Value = serde_json::from_str(include_str!("avif-reference.json")).expect("the reference parses");
    reference["rows"].as_array().expect("rows").clone()
}

fn bytes_of(row: &Value) -> Vec<u8> {
    STANDARD.decode(row["input"].as_str().expect("input")).expect("the input is base64")
}

fn rgba_of(recorded: &Value) -> Vec<u8> {
    STANDARD.decode(recorded["rgba"].as_str().expect("rgba")).expect("the pixels are base64")
}

fn name_of(row: &Value) -> &str {
    row["name"].as_str().unwrap_or_default()
}

fn mean_difference(ours: &[u8], theirs: &[u8]) -> f64 {
    let total: u64 = ours.iter().zip(theirs).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
    total as f64 / ours.len().max(1) as f64
}

/// The mean of every cell of a 32x32 grid over RGBA pixels, rounded (the main corpus's rule).
fn thumbnail(rgba: &[u8], width: usize, height: usize) -> Vec<f64> {
    let mut out = vec![0f64; THUMB * THUMB * 4];
    for cy in 0..THUMB {
        let y0 = cy * height / THUMB;
        let y1 = height.min(((cy + 1) * height / THUMB).max(y0 + 1));
        for cx in 0..THUMB {
            let x0 = cx * width / THUMB;
            let x1 = width.min(((cx + 1) * width / THUMB).max(x0 + 1));
            let mut sums = [0f64; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    for (channel, sum) in sums.iter_mut().enumerate() {
                        *sum += f64::from(rgba[(y * width + x) * 4 + channel]);
                    }
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as f64;
            for (channel, sum) in sums.iter().enumerate() {
                out[(cy * THUMB + cx) * 4 + channel] = (sum / count).round();
            }
        }
    }
    out
}

/// `(psnr, mean absolute difference)` of two thumbnails.
fn closeness(ours: &[f64], theirs: &[f64]) -> (f64, f64) {
    let (mut squares, mut absolute) = (0f64, 0f64);
    for (a, b) in ours.iter().zip(theirs) {
        squares += (a - b) * (a - b);
        absolute += (a - b).abs();
    }
    let count = ours.len() as f64;
    let mse = squares / count;
    let psnr = if mse == 0.0 { f64::INFINITY } else { 10.0 * (255.0f64 * 255.0 / mse).log10() };
    (psnr, absolute / count)
}

/// The libheif line of sharp's text: the part from `heif:` on (the `source: bad seek` lines before it belong to
/// sharp's reader).
fn heif_line(text: &str) -> &str {
    text.find("heif:").map_or(text, |at| &text[at..])
}

#[test]
fn the_reference_holds_every_kind_of_input() {
    let names: Vec<String> = rows().iter().map(|row| name_of(row).to_owned()).collect();
    for wanted in ["plain", "alpha", "rotate90", "mirrorVertical", "crop", "cropOffset", "nclxBt709Full", "iccProfile", "heic", "truncatedHalf", "payloadDamaged"] {
        assert!(names.iter().any(|name| name == wanted), "no {wanted} row");
    }
}

#[test]
fn a_decode_equals_sharps_pixels_after_the_container_properties() {
    let mut failures = Vec::new();
    for row in rows() {
        let name = name_of(&row);
        let bytes = bytes_of(&row);
        let Some(recorded) = row["raw"].get("ok") else { continue };
        let (width, height) = (recorded["width"].as_u64().unwrap() as u32, recorded["height"].as_u64().unwrap() as u32);
        match decode(&bytes, DECODE_PIXEL_LIMIT) {
            Err(error) => failures.push(format!("{name}: sharp decodes it, got {error}")),
            Ok(decoded) => {
                if (decoded.width, decoded.height) != (width, height) {
                    failures.push(format!("{name}: {}x{}, sharp's {width}x{height}", decoded.width, decoded.height));
                    continue;
                }
                let difference = mean_difference(&decoded.raster.to_rgba(), &rgba_of(recorded));
                if difference > MAX_DECODE_MEAN_DIFFERENCE {
                    failures.push(format!("{name}: the pixels differ by {difference:.2} on average"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_probe_and_a_decode_fail_where_sharp_fails_with_its_libheif_sentence() {
    let mut failures = Vec::new();
    for row in rows() {
        let name = name_of(&row);
        let bytes = bytes_of(&row);
        let Some(recorded) = row["raw"].get("error") else { continue };
        let want = heif_line(recorded.as_str().unwrap_or_default());
        for outcome in [probe(&bytes).map(|_| ()), decode(&bytes, DECODE_PIXEL_LIMIT).map(|_| ())] {
            let Err(error) = outcome else {
                failures.push(format!("{name}: sharp fails ({want}), this decodes it"));
                continue;
            };
            if error.class() != ErrorClass::Invalid {
                failures.push(format!("{name}: class {:?}, sharp's invalid", error.class()));
            }
            let got = heif_line(error.sentence());
            // The HEVC answer is a fixed sentence and is equal; the others carry libheif's words for what failed
            // (which boxes a truncated file cuts is told by position in sharp's text), so the family is compared.
            let equal = if name.starts_with("heic") || name == "heix" { got == want } else { got.starts_with("heif: Invalid input") && want.starts_with("heif: Invalid input") };
            if !equal {
                failures.push(format!("{name}: the sentence is {got:?}, sharp's {want:?}"));
            }
            // libvips says "corrupt header" when libheif stops before the image is opened, and only then.
            let header = |text: &str| text.starts_with("Input buffer has corrupt header: ");
            if header(error.sentence()) != header(recorded.as_str().unwrap_or_default()) {
                failures.push(format!("{name}: {:?} against sharp's {:?} (corrupt-header prefix)", error.sentence(), recorded));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_resized_avif_is_an_avif_labelled_heif_that_reads_back_as_sharps_does() {
    let mut failures = Vec::new();
    for row in rows() {
        let name = name_of(&row);
        let bytes = bytes_of(&row);
        let recorded = &row["resize"];
        match (recorded.get("ok"), resize_image_buffer(&bytes, "avif", ResizeOptions::default())) {
            (Some(ok), Ok(Some(resized))) => {
                let dims = resized.dimensions;
                let want: Vec<u64> = ["originalWidth", "originalHeight", "displayWidth", "displayHeight"].iter().map(|key| ok["dimensions"][key].as_u64().unwrap()).collect();
                let have = [dims.original_width, dims.original_height, dims.display_width, dims.display_height].map(u64::from);
                if have.as_slice() != want.as_slice() {
                    failures.push(format!("{name}: dimensions {have:?}, sharp's {want:?}"));
                    continue;
                }
                if resized.mime != ok["mime"].as_str().unwrap() {
                    failures.push(format!("{name}: mime {}, sharp's {}", resized.mime, ok["mime"]));
                }
                if resized.data.len() < 12 || &resized.data[4..12] != b"ftypavif" {
                    failures.push(format!("{name}: the output is not an AVIF file"));
                    continue;
                }
                let Ok(back) = decode(&resized.data, DECODE_PIXEL_LIMIT) else {
                    failures.push(format!("{name}: the output does not decode"));
                    continue;
                };
                let (width, height) = (ok["outputWidth"].as_u64().unwrap() as usize, ok["outputHeight"].as_u64().unwrap() as usize);
                if (back.width as usize, back.height as usize) != (width, height) || back.raster.has_alpha != ok["outputHasAlpha"].as_bool().unwrap() {
                    failures.push(format!("{name}: the output is {}x{} (alpha {}), sharp's {width}x{height} (alpha {})", back.width, back.height, back.raster.has_alpha, ok["outputHasAlpha"]));
                    continue;
                }
                let theirs: Vec<f64> = STANDARD.decode(ok["outputThumbnail"].as_str().unwrap()).expect("the thumbnail is base64").iter().map(|byte| f64::from(*byte)).collect();
                let (psnr, mad) = closeness(&thumbnail(&back.raster.to_rgba(), width, height), &theirs);
                if psnr < MIN_PSNR || mad > MAX_MEAN_ABSOLUTE_DIFFERENCE {
                    failures.push(format!("{name}: pixels differ (PSNR {psnr:.1} dB, mean difference {mad:.2})"));
                }
            }
            (None, Err(error)) => {
                if error.class() != ErrorClass::Invalid || !error.message().starts_with("invalid or corrupt image data: ") {
                    failures.push(format!("{name}: the failure is {error}, sharp's {}", recorded["error"]));
                }
            }
            (want, got) => failures.push(format!("{name}: sharp's answer {} against {got:?}", want.map_or("an error", |_| "ok"))),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn colour_information_moves_the_pixels_as_far_as_sharps_does() {
    // Each of these files differs from the plain one only in its colr box; sharp's pixels differ from the plain
    // file's by the recorded amount, and ours must be nearer to sharp's than the plain file's are.
    let all = rows();
    let find = |wanted: &str| all.iter().find(|row| name_of(row) == wanted).unwrap_or_else(|| panic!("no {wanted} row"));
    let plain = rgba_of(&find("plain")["raw"]["ok"]);
    for wanted in ["nclxBt709Full", "nclxBt709Limited", "nclxBt2020", "nclxIdentity", "iccProfile"] {
        let row = find(wanted);
        let sharp = rgba_of(&row["raw"]["ok"]);
        let moved = mean_difference(&plain, &sharp);
        let ours = decode(&bytes_of(row), DECODE_PIXEL_LIMIT).unwrap().raster.to_rgba();
        let off = mean_difference(&ours, &sharp);
        assert!(off < moved / 2.0, "{wanted}: sharp moves the pixels by {moved:.2}, ours are {off:.2} from sharp's");
    }
}

#[test]
fn an_hevc_file_is_probed_and_decoded_as_the_invalid_image_sharp_reports() {
    let row = rows().into_iter().find(|row| name_of(row) == "heic").expect("the heic row");
    let bytes = bytes_of(&row);
    let error = decode(&bytes, DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.sentence(), heif_line(row["raw"]["error"].as_str().unwrap()));
    let wrapped = resize_image_buffer(&bytes, "heic", ResizeOptions::default()).unwrap_err();
    assert!(wrapped.message().starts_with("invalid or corrupt image data: heif: Error while loading plugin: "), "{wrapped}");
}
