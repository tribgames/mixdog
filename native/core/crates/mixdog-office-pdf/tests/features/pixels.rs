//! Page rendering asserted by pixels for small synthetic pages: what a drawn rectangle, a clip and a transform put on the raster
//! follows from the PDF drawing rules, so the expected colours are read off the geometry, not off a recording.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use mixdog_fonts::registry::Registry;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::{RenderPagesOptions, render_pdf_pages};
use mixdog_raster::image::Image;

struct Noted(Mutex<Vec<PathBuf>>);

impl WriteNote for Noted {
    fn note_write(&self, path: &Path) {
        self.0.lock().expect("lock").push(path.to_path_buf());
    }
}

/// A one-page 100 x 100 point PDF whose page content is `content`, with a correct cross-reference table.
fn page_pdf(content: &str) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len() + 1),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (at, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", at + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

/// The page drawn 200 pixels wide (a scale of 2 over its 100 points) and read back from the PNG written beside it.
fn raster_of(name: &str, content: &str) -> Image {
    let directory = std::env::temp_dir().join(format!("mixdog-office-pdf-pixels-{}-{name}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let path = directory.join("page.pdf");
    std::fs::write(&path, page_pdf(content)).expect("written");
    let note: Arc<dyn WriteNote> = Arc::new(Noted(Mutex::new(Vec::new())));
    let runtime = tokio::runtime::Builder::new_current_thread().build().expect("runtime");
    let rendered = runtime
        .block_on(render_pdf_pages(mixdog_rt::testing::tokens(), Arc::new(Registry::new()), note, &path, RenderPagesOptions { max_width: 200.0, ..RenderPagesOptions::default() }))
        .expect("rendered");
    assert_eq!(rendered.to_json()["images"][0]["width"], 200);
    Image::decode(&std::fs::read(directory.join("page-page-1.png")).expect("the png beside the pdf")).expect("a png")
}

/// The colour of the pixel under the page point (`x`, `y`) in PDF space, whose origin is the bottom left.
fn at(image: &Image, x: f64, y: f64) -> [u8; 3] {
    let scale = f64::from(image.width()) / 100.0;
    let (column, row) = ((x * scale) as usize, ((100.0 - y) * scale) as usize);
    let at = (row * image.width() as usize + column) * 4;
    let rgba = image.rgba();
    [rgba[at], rgba[at + 1], rgba[at + 2]]
}

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

#[test]
fn a_filled_rectangle_colours_exactly_the_pixels_inside_it_on_a_white_page() {
    let image = raster_of("fill", "1 0 0 rg 20 30 40 20 re f");
    assert_eq!(at(&image, 40.0, 40.0), RED, "the middle of the rectangle");
    assert_eq!(at(&image, 21.5, 31.5), RED, "just inside its lower left corner");
    assert_eq!(at(&image, 58.5, 48.5), RED, "just inside its upper right corner");
    for (x, y) in [(10.0, 40.0), (70.0, 40.0), (40.0, 20.0), (40.0, 60.0), (2.0, 2.0), (98.0, 98.0)] {
        assert_eq!(at(&image, x, y), WHITE, "({x}, {y}) is outside the rectangle");
    }
}

#[test]
fn a_clip_limits_a_later_fill_to_the_clipped_area_and_a_restored_state_ends_it() {
    let image = raster_of("clip", "q 30 30 40 40 re W n 0 0 1 rg 0 0 100 100 re f Q 1 0 0 rg 0 0 10 10 re f");
    assert_eq!(at(&image, 50.0, 50.0), BLUE, "inside the clip");
    assert_eq!(at(&image, 31.5, 68.5), BLUE, "inside the clip at its corner");
    for (x, y) in [(20.0, 50.0), (80.0, 50.0), (50.0, 20.0), (50.0, 80.0), (90.0, 90.0)] {
        assert_eq!(at(&image, x, y), WHITE, "({x}, {y}) is outside the clip");
    }
    assert_eq!(at(&image, 5.0, 5.0), RED, "after Q the clip no longer limits the fill");
}

#[test]
fn a_transform_moves_and_scales_the_drawing_and_a_later_fill_colour_replaces_an_earlier_one() {
    // The unit square, scaled to 20 x 10 and moved to (50, 60), then a blue fill over the same square's left half.
    let image = raster_of("transform", "q 20 0 0 10 50 60 cm 1 0 0 rg 0 0 1 1 re f Q 0 0 1 rg 50 60 10 10 re f");
    assert_eq!(at(&image, 65.0, 65.0), RED, "the scaled square's right half");
    assert_eq!(at(&image, 55.0, 65.0), BLUE, "the later fill covers the left half");
    assert_eq!(at(&image, 45.0, 65.0), WHITE, "left of the moved square");
    assert_eq!(at(&image, 75.0, 65.0), WHITE, "right of the scaled square");
    assert_eq!(at(&image, 60.0, 75.0), WHITE, "above the scaled square");
    assert_eq!(at(&image, 5.0, 5.0), WHITE, "the unmoved origin stays empty");
}