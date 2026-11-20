//! `authoring/pptx-contact-sheet.mjs`: one labelled grid of every rendered slide, written beside the deck after an
//! author call. The per-page renders are for inspecting a slide; the sheet is for reading the deck as a sequence:
//! density rhythm, repeated compositions, where the titles sit, which slides change the background.
//!
//! The pages are PNGs (base64, as the render returns them) set on a [`mixdog_raster::canvas::Canvas`], each under its
//! page number (set with the font registry's `sans-serif`, the canvas's own default family) and inside a one-pixel
//! frame. The grid has two columns up to four pages, three up to nine and four beyond.

use std::path::Path;

use base64::Engine;
use base64::alphabet;
use base64::engine::GeneralPurposeConfig;
use base64::engine::general_purpose::{GeneralPurpose, STANDARD};
use mixdog_fonts::registry::Registry;
use mixdog_fsio::WriteProof;
use mixdog_js::nodepath::{self, Style};
use mixdog_js::{js_sort_by, json_number, number_to_string, to_number_of};
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_raster::Image;
use mixdog_raster::canvas::{Bitmap, Canvas};
use serde_json::{Map, Value, json};

/// The default sheet width in pixels.
pub const DEFAULT_WIDTH: u32 = 1600;

const GAP: u32 = 14;
const LABEL: u32 = 22;

/// The sheet that was written: its file, its size, the pages it lists in order, and its PNG (base64).
#[derive(Clone, PartialEq, Debug)]
pub struct ContactSheet {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub pages: Vec<f64>,
    pub data: String,
}

impl ContactSheet {
    pub const MIME_TYPE: &'static str = "image/png";

    /// What the review result lists about the sheet: everything but its pixels, keys in Node's order.
    pub fn meta(&self) -> Map<String, Value> {
        let Value::Object(map) = json!({
            "path": self.path,
            "width": self.width,
            "height": self.height,
            "pages": self.pages.iter().map(|page| json_number(*page)).collect::<Vec<_>>(),
            "mimeType": Self::MIME_TYPE,
        }) else {
            unreachable!("an object literal")
        };
        map
    }
}

/// The page images of a render: a render's `pageImages` where it has them, else the entry itself when it is a page (it
/// has pixels and a page number above zero); those with pixels, in page order.
fn page_images(images: &[Value]) -> Vec<&Value> {
    let mut pages: Vec<&Value> = Vec::new();
    for image in images {
        match image.get("pageImages").and_then(Value::as_array) {
            Some(list) if !list.is_empty() => pages.extend(list.iter()),
            _ if image.get("data").is_some_and(truthy) && to_number_of(image.get("page")) > 0.0 => pages.push(image),
            _ => {}
        }
    }
    pages.retain(|page| page.get("data").is_some_and(truthy));
    js_sort_by(&mut pages, |a, b| to_number_of(a.get("page")) - to_number_of(b.get("page")));
    pages
}

/// `Buffer.from(text, 'base64')`: both alphabets, anything else skipped, padding optional.
pub fn decode_base64(text: &str) -> Vec<u8> {
    let mut clean: Vec<u8> = text
        .bytes()
        .filter_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            _ => None,
        })
        .collect();
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    engine.decode(&clean).unwrap_or_default()
}

/// Two columns up to four pages, three up to nine, four beyond.
fn columns_for(pages: usize) -> u32 {
    match pages {
        0..=4 => 2,
        5..=9 => 3,
        _ => 4,
    }
}

/// Node's `Math.round` for the sizes here (never negative).
fn js_round(value: f64) -> u32 {
    (value + 0.5).floor() as u32
}

struct Cell {
    page: f64,
    image: Bitmap,
    height: u32,
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;

    use super::*;

    fn flat_png(width: u32, height: u32, shade: u8) -> String {
        let image = Image::from_raw(width, height, 3, &vec![shade; (width * height * 3) as usize]).expect("raw image");
        STANDARD.encode(image.to_png().expect("png"))
    }

    fn page(number: u32, width: u32, height: u32) -> Value {
        json!({ "page": number, "data": flat_png(width, height, 200), "mimeType": "image/png" })
    }

    #[test]
    fn a_page_set_is_sorted_and_flattened() {
        let images = vec![
            json!({ "page": 0, "pageImages": [page(3, 4, 4), page(1, 4, 4)] }),
            page(2, 4, 4),
            json!({ "page": 5 }),
            json!({ "data": "AAAA" }),
            json!({ "page": 4, "pageImages": [], "data": "AAAA" }),
        ];
        let order: Vec<f64> = page_images(&images).iter().map(|page| to_number_of(page.get("page"))).collect();
        assert_eq!(order, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn base64_is_read_as_node_reads_it() {
        assert_eq!(decode_base64("aGk="), b"hi");
        assert_eq!(decode_base64("aGk"), b"hi");
        assert_eq!(decode_base64("a G\nk="), b"hi");
        assert_eq!(decode_base64("-_-_"), decode_base64("+/+/"));
        assert_eq!(decode_base64(""), Vec::<u8>::new());
    }

    #[test]
    fn the_grid_has_two_three_or_four_columns() {
        let columns: Vec<u32> = [2, 4, 5, 9, 10, 13].into_iter().map(columns_for).collect();
        assert_eq!(columns, [2, 2, 3, 3, 4, 4]);
    }

    #[test]
    fn a_cell_height_rounds_half_up() {
        assert_eq!(js_round(2.5), 3);
        assert_eq!(js_round(2.4999), 2);
    }

    #[test]
    fn the_sheet_lies_beside_the_deck() {
        let sep = if cfg!(windows) { '\\' } else { '/' };
        assert_eq!(sheet_path("deck.pdf"), "deck.mixdog-contact.png");
        assert_eq!(sheet_path("/work/out/deck.v2.pdf"), format!("{sep}work{sep}out{sep}deck.v2.mixdog-contact.png"));
        assert_eq!(sheet_path("/deck"), format!("{sep}deck.mixdog-contact.png"));
        assert_eq!(sheet_path("/work/.hidden"), format!("{sep}work{sep}.hidden.mixdog-contact.png"));
        assert_eq!(sheet_path("a/b/deck.pptx"), format!("a{sep}b{sep}deck.mixdog-contact.png"));
    }
    #[test]
    fn fewer_than_two_pages_make_no_sheet() {
        let registry = Registry::new();
        let none = write_contact_sheet(&Unlaned, &registry, &NoWriteNote, &[page(1, 4, 4)], "unused.pdf", DEFAULT_WIDTH);
        assert_eq!(none, Ok(None));
        let none = write_contact_sheet(&Unlaned, &registry, &NoWriteNote, &[], "unused.pdf", DEFAULT_WIDTH);
        assert_eq!(none, Ok(None));
    }
    #[test]
    fn a_page_that_does_not_decode_fails_the_sheet() {
        let registry = Registry::new();
        let bad = json!({ "page": 2, "data": "AAAA" });
        let failed = write_contact_sheet(&Unlaned, &registry, &NoWriteNote, &[page(1, 4, 4), bad], "unused.pdf", DEFAULT_WIDTH);
        assert!(failed.is_err());
    }
}

/// Writes the contact sheet of `images` beside `output` as `<stem>.mixdog-contact.png`, the file reported to `note`
/// first. `Ok(None)` for fewer than two pages; an error when a page does not decode, the labels cannot be set or the
/// file is not written (the review then goes without a sheet).
pub fn write_contact_sheet<P: WriteProof>(
    proof: &P,
    registry: &Registry,
    note: &dyn WriteNote,
    images: &[Value],
    output: &str,
    width: u32,
) -> Result<Option<ContactSheet>, String> {
    let pages = page_images(images);
    if pages.len() < 2 {
        return Ok(None);
    }
    let columns = columns_for(pages.len());
    let cell_width = (width.saturating_sub(GAP * (columns + 1))) / columns;
    if cell_width == 0 {
        return Err("the sheet is too narrow for its pages".to_owned());
    }
    let mut cells = Vec::with_capacity(pages.len());
    for page in &pages {
        let bytes = decode_base64(page.get("data").and_then(Value::as_str).unwrap_or_default());
        let image = Image::decode(&bytes).map_err(|error| error.to_string())?;
        let height = js_round(f64::from(image.height()) * f64::from(cell_width) / f64::from(image.width()));
        cells.push(Cell { page: to_number_of(page.get("page")), image: Bitmap::from_image(&image).map_err(|error| error.to_string())?, height });
    }
    let cell_height = cells.iter().map(|cell| cell.height).max().unwrap_or(0);
    let rows = (cells.len() as u32).div_ceil(columns);
    let (sheet_width, sheet_height) = (width, GAP + rows * (LABEL + cell_height + GAP));
    let mut sheet = Canvas::new(sheet_width, sheet_height).map_err(|error| error.to_string())?;
    sheet.set_fill_color("rgb(236,238,242)");
    sheet.fill_rect(0.0, 0.0, sheet_width as f32, sheet_height as f32);
    sheet.set_font("15px sans-serif");
    sheet.set_text_baseline("middle");
    for (index, cell) in cells.iter().enumerate() {
        let index = index as u32;
        let x = GAP + (index % columns) * (cell_width + GAP);
        let y = GAP + (index / columns) * (LABEL + cell_height + GAP);
        sheet.set_fill_color("rgb(60,64,72)");
        sheet.fill_text(proof, registry, &number_to_string(cell.page), x as f32, y as f32 + LABEL as f32 / 2.0, None).map_err(|error| error.to_string())?;
        sheet.draw_image_scaled(&cell.image, x as f32, (y + LABEL) as f32, cell_width as f32, cell.height as f32);
        sheet.set_stroke_color("rgb(190,194,202)");
        sheet.stroke_rect(x as f32 + 0.5, (y + LABEL) as f32 + 0.5, cell_width as f32 - 1.0, cell.height as f32 - 1.0);
    }
    let data = sheet.to_png().map_err(|error| error.to_string())?;
    let path = sheet_path(output);
    note.note_write(Path::new(&path));
    mixdog_fsio::write(proof, &path, &data).map_err(|error| error.to_string())?;
    Ok(Some(ContactSheet {
        path,
        width: sheet_width,
        height: sheet_height,
        pages: cells.into_iter().map(|cell| cell.page).collect(),
        data: STANDARD.encode(&data),
    }))
}
/// `join(dirname(output), `${basename(output, extname(output))}.mixdog-contact.png`)`.
fn sheet_path(output: &str) -> String {
    let style = Style::host();
    let is_separator = |c: char| c == '/' || (style == Style::Win32 && c == '\\');
    let trimmed = output.trim_end_matches(is_separator);
    let (directory, name) = match trimmed.rfind(is_separator) {
        None => (".", trimmed),
        Some(0) => ("/", &trimmed[1..]),
        Some(at) if style == Style::Win32 && trimmed[..at].len() == 2 && trimmed.as_bytes()[1] == b':' => (&trimmed[..=at], &trimmed[at + 1..]),
        Some(at) => (&trimmed[..at], &trimmed[at + 1..]),
    };
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 && name != ".." => &name[..dot],
        _ => name,
    };
    let file = format!("{stem}.mixdog-contact.png");
    let joined = if directory.ends_with(is_separator) { format!("{directory}{file}") } else { format!("{directory}/{file}") };
    nodepath::normalize(style, &joined)
}
