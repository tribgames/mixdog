use std::path::Path;

use base64::Engine;
use mixdog_fsio::WriteProof;
use mixdog_js::math::round;
use mixdog_js::{json_number, number_to_string, to_number_of};
use mixdog_office_base::write_note::WriteNote;
use mixdog_raster::canvas::{Canvas, ImageData};
use serde_json::{Value, json};

use crate::aesthetics_metrics::rounded;
use crate::field;
use crate::rendered::{decode_image, paint_on_white};

/// The image of each page number; a later image of the same page replaces an earlier one.
fn image_by_page(images: &[Value]) -> Vec<(f64, &Value)> {
    let mut by_page: Vec<(f64, &Value)> = Vec::new();
    for image in images {
        let page = to_number_of(field(image, "page"));
        match by_page.iter_mut().find(|(known, _)| *known == page || (known.is_nan() && page.is_nan())) {
            Some(slot) => slot.1 = image,
            None => by_page.push((page, image)),
        }
    }
    by_page
}

fn lookup<'a>(by_page: &[(f64, &'a Value)], page: f64) -> Option<&'a Value> {
    by_page.iter().find(|(known, _)| *known == page || (known.is_nan() && page.is_nan())).map(|(_, image)| *image)
}

/// The decoded picture of a page image, or `None` when the page has no image on that side.
fn load(image: Option<&Value>) -> Result<Option<mixdog_raster::Image>, String> {
    image.map(|image| decode_image(field(image, "data").unwrap_or(&Value::Null))).transpose()
}

/// A pixel counts as changed from this channel delta.
const CHANGED_CHANNEL_DELTA: u8 = 24;

fn page_numbers(before: &[(f64, &Value)], after: &[(f64, &Value)]) -> Vec<f64> {
    let mut pages: Vec<f64> = Vec::new();
    for (page, _) in before.iter().chain(after.iter()) {
        if !pages.iter().any(|known| known == page || (known.is_nan() && page.is_nan())) {
            pages.push(*page);
        }
    }
    pages.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    pages
}

/// The diff page, the changed pixels in red over the dimmed grey of the new page, and how many pixels changed.
fn diff_page(before: &[u8], after: &[u8], width: u32, height: u32) -> Result<(ImageData, u64), String> {
    let mut diff = ImageData::new(width, height).map_err(|error| error.to_string())?;
    let mut changed = 0u64;
    for (index, (a, b)) in before.chunks_exact(4).zip(after.chunks_exact(4)).enumerate() {
        let delta = (0..3).map(|channel| a[channel].abs_diff(b[channel])).max().unwrap_or(0);
        let out = &mut diff.data_mut()[index * 4..index * 4 + 4];
        if delta >= CHANGED_CHANNEL_DELTA {
            changed += 1;
            out.copy_from_slice(&[239, 68, 68, 230]);
        } else {
            let grey = round((f64::from(b[0]) + f64::from(b[1]) + f64::from(b[2])) / 3.0) as u8;
            out.copy_from_slice(&[grey, grey, grey, 55]);
        }
    }
    Ok((diff, changed))
}

/// `compareRenderedPages(beforeImages, afterImages, outputPdf)`: the pages of both sides in page order, the changed
/// share of each, their mean, and the diff images, written beside `output_pdf` as `<stem>-visual-diff-page-<n>.png`
/// (each path is reported to `note` before it is written). A side without a page compares against white; a page
/// image that cannot be decoded is an error.
pub fn compare_rendered_pages<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    before_images: &[Value],
    after_images: &[Value],
    output_pdf: &Path,
) -> Result<Value, String> {
    let before = image_by_page(before_images);
    let after = image_by_page(after_images);
    let pages = page_numbers(&before, &after);
    let stem = output_pdf.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let directory = output_pdf.parent().unwrap_or_else(|| Path::new(""));
    let mut metrics = Vec::new();
    let mut percents = Vec::new();
    let mut images = Vec::new();
    for page in pages {
        let left = load(lookup(&before, page))?;
        let right = load(lookup(&after, page))?;
        let width = left.as_ref().map_or(0, |image| image.width()).max(right.as_ref().map_or(0, |image| image.width()));
        let height = left.as_ref().map_or(0, |image| image.height()).max(right.as_ref().map_or(0, |image| image.height()));
        if width == 0 || height == 0 {
            continue;
        }
        let before_pixels = paint_on_white(left.as_ref(), width, height, false)?;
        let after_pixels = paint_on_white(right.as_ref(), width, height, false)?;
        let (diff, changed) = diff_page(before_pixels.data(), after_pixels.data(), width, height)?;
        let mut canvas = Canvas::new(width, height).map_err(|error| error.to_string())?;
        canvas.put_image_data(&diff, 0, 0, None);
        let data = canvas.to_png().map_err(|error| error.to_string())?;
        let path = directory.join(format!("{stem}-visual-diff-page-{}.png", number_to_string(page)));
        note.note_write(&path);
        mixdog_fsio::write(proof, &path, &data).map_err(|error| format!("{error}, open '{}'", path.display()))?;
        let total = f64::from(width) * f64::from(height);
        let changed_percent = rounded(changed as f64 / total * 100.0, 3);
        percents.push(changed_percent);
        metrics.push(json!({
            "page": json_number(page),
            "changedPixels": changed,
            "totalPixels": json_number(total),
            "changedPercent": json_number(changed_percent),
        }));
        images.push(json!({
            "page": json_number(page),
            "path": path.to_string_lossy(),
            "width": width,
            "height": height,
            "mimeType": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(&data),
            "kind": "visual-diff",
        }));
    }
    let changed_percent = if percents.is_empty() { 0.0 } else { rounded(percents.iter().fold(0.0, |sum, value| sum + value) / percents.len() as f64, 3) };
    Ok(json!({
        "available": !metrics.is_empty(),
        "pages": metrics,
        "changedPercent": json_number(changed_percent),
        "images": images,
    }))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use base64::Engine;
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;

    use super::*;
    use crate::rendered::test_pages::{painted, rect};

    /// A page image one pixel high whose pixels are the grey `shades`.
    fn shades(page: u32, shades: &[u8]) -> Value {
        let data = painted(shades.len() as u32, 1, |canvas| {
            for (index, shade) in shades.iter().enumerate() {
                rect(canvas, &format!("rgb({shade}, {shade}, {shade})"), index as f32, 0.0, 1.0, 1.0);
            }
        });
        json!({ "page": page, "data": data })
    }

    struct Recording(Mutex<Vec<PathBuf>>);

    impl WriteNote for Recording {
        fn note_write(&self, path: &Path) {
            self.0.lock().expect("lock").push(path.to_path_buf());
        }
    }

    #[test]
    fn visual_diff_keeps_the_pixel_threshold_page_order_missing_pages_and_saved_evidence() {
        let directory = tempfile::tempdir().expect("directory");
        let output = directory.path().join("review.pdf");
        let notes = Recording(Mutex::new(Vec::new()));
        let result = compare_rendered_pages(&Unlaned, &notes, &[shades(2, &[0]), shades(1, &[255, 255])], &[shades(1, &[232, 231])], &output).expect("diff");
        assert_eq!(result["available"], json!(true));
        assert_eq!(
            result["pages"],
            json!([
                { "page": 1, "changedPixels": 1, "totalPixels": 2, "changedPercent": 50 },
                { "page": 2, "changedPixels": 1, "totalPixels": 1, "changedPercent": 100 },
            ])
        );
        assert_eq!(result["changedPercent"], json!(75));
        let images = result["images"].as_array().expect("images");
        assert_eq!(images.len(), 2);
        for (index, entry) in images.iter().enumerate() {
            let expected = directory.path().join(format!("review-visual-diff-page-{}.png", index + 1));
            assert_eq!(entry["page"], json!(index + 1));
            assert_eq!(entry["path"], json!(expected.to_string_lossy()));
            assert_eq!(entry["width"], json!(if index == 0 { 2 } else { 1 }));
            assert_eq!(entry["height"], json!(1));
            assert_eq!(entry["mimeType"], "image/png");
            assert_eq!(entry["kind"], "visual-diff");
            let bytes = mixdog_fsio::read(&Unlaned, &expected).expect("saved diff");
            assert_eq!(base64::engine::general_purpose::STANDARD.decode(entry["data"].as_str().expect("data")).expect("base64"), bytes);
            let decoded = mixdog_raster::Image::decode(&bytes).expect("a png");
            assert_eq!((decoded.width(), decoded.height()), (entry["width"].as_u64().expect("w") as u32, 1));
        }
        assert_eq!(notes.0.lock().expect("lock").len(), 2);
    }

    #[test]
    fn visual_diff_pads_unequal_dimensions_and_reports_an_empty_comparison_without_evidence() {
        let directory = tempfile::tempdir().expect("directory");
        let output = directory.path().join("review.pdf");
        let result = compare_rendered_pages(&Unlaned, &NoWriteNote, &[shades(1, &[0])], &[shades(1, &[0, 0])], &output).expect("diff");
        assert_eq!(result["pages"], json!([{ "page": 1, "changedPixels": 1, "totalPixels": 2, "changedPercent": 50 }]));
        let empty = compare_rendered_pages(&Unlaned, &NoWriteNote, &[], &[], &output).expect("empty");
        assert_eq!(empty, json!({ "available": false, "pages": [], "changedPercent": 0, "images": [] }));
        assert!(compare_rendered_pages(&Unlaned, &NoWriteNote, &[], &[json!({ "page": 1, "data": "not an image" })], &output).is_err());
    }
}
