//! The contact sheets of a long render (`contactSheet` of `pdf/pdf-render.mjs`): more than twelve pages are reviewed as
//! at most twelve labelled grids, one image per group of pages. A sheet is a grey field of cells; each cell holds a
//! page's thumbnail under its `Page N` label inside a one-pixel frame.

use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use mixdog_raster::Image;
use mixdog_raster::canvas::{Bitmap, Canvas};

use crate::render::text_unavailable;

/// The most images one render returns: the most explicit pages, and the most sheets.
pub const MAX_RENDER_IMAGES: usize = 12;

const GAP: u32 = 12;
const LABEL_HEIGHT: u32 = 24;
const MIN_CELL_WIDTH: u32 = 64;
/// The sheet is at least this wide whatever width was asked for.
const MIN_SHEET_WIDTH: f64 = 256.0;

/// `Math.max(256, Number(maxWidth) || 1400)`: the width of a sheet (`maxWidth` is NaN or 0 when it is not a number the
/// call can use).
pub fn sheet_width(max_width: f64) -> f64 {
    let wanted = if max_width == 0.0 || max_width.is_nan() { 1400.0 } else { max_width };
    if wanted.is_nan() { wanted } else { wanted.max(MIN_SHEET_WIDTH) }
}

/// The groups the pages are cut into: `ceil(pages / 12)` pages a sheet, in order, so there are at most twelve sheets.
pub fn page_groups(selected: &[usize]) -> Vec<Vec<usize>> {
    let per_sheet = selected.len().div_ceil(MAX_RENDER_IMAGES).max(1);
    selected.chunks(per_sheet).map(<[usize]>::to_vec).collect()
}

/// How the cells of a sheet are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grid {
    pub columns: u32,
    pub rows: u32,
    /// The width a thumbnail is rendered to fit.
    pub cell_width: u32,
}

/// One column up to two pages, else `max(2, ceil(sqrt(pages * 0.75)))`; the cells fill the width between gaps.
pub fn grid(pages: usize, width: f64) -> Grid {
    let columns = if pages <= 2 { 1 } else { (((pages as f64) * 0.75).sqrt().ceil() as u32).max(2) };
    let rows = (pages as u32).div_ceil(columns);
    let free = (width - f64::from((columns + 1) * GAP)) / f64::from(columns);
    let cell_width = if free.is_nan() { MIN_CELL_WIDTH } else { (free.floor().max(f64::from(MIN_CELL_WIDTH))) as u32 };
    Grid { columns, rows, cell_width }
}

/// A page rendered for a sheet: its number and its PNG.
pub struct Thumbnail {
    pub page: usize,
    pub png: Vec<u8>,
}

/// The size of a sheet and its PNG.
pub struct Sheet {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

/// Sets the thumbnails on a grey field, each under its label and inside a frame; the sheet is `width` pixels wide
/// (`createCanvas` truncates it).
pub fn compose<P: ReadProof>(proof: &P, registry: &Registry, thumbnails: &[Thumbnail], grid: Grid, width: f64) -> Result<Sheet, String> {
    let mut cells = Vec::with_capacity(thumbnails.len());
    for thumbnail in thumbnails {
        let image = Image::decode(&thumbnail.png).map_err(|error| error.to_string())?;
        let bitmap = Bitmap::from_image(&image).map_err(|error| error.to_string())?;
        cells.push((thumbnail.page, image.width(), image.height(), bitmap));
    }
    let cell_height = cells.iter().map(|(_, _, height, _)| *height).max().unwrap_or(0);
    let sheet_width = width as u32;
    let sheet_height = GAP + grid.rows * (LABEL_HEIGHT + cell_height + GAP);
    let mut sheet = Canvas::new(sheet_width, sheet_height).map_err(|error| error.to_string())?;
    sheet.set_fill_color("rgb(238,240,244)");
    sheet.fill_rect(0.0, 0.0, sheet_width as f32, sheet_height as f32);
    sheet.set_font("16px sans-serif");
    sheet.set_text_baseline("middle");
    for (index, (page, image_width, image_height, bitmap)) in cells.iter().enumerate() {
        let index = index as u32;
        let x = (GAP + (index % grid.columns) * (grid.cell_width + GAP)) as f32;
        let y = (GAP + (index / grid.columns) * (LABEL_HEIGHT + cell_height + GAP)) as f32;
        let picture_top = y + LABEL_HEIGHT as f32;
        sheet.set_fill_color("rgb(45,50,60)");
        if let Err(error) = sheet.fill_text(proof, registry, &format!("Page {page}"), x, y + LABEL_HEIGHT as f32 / 2.0, None) {
            text_unavailable(&error.to_string());
        }
        sheet.set_fill_color("rgb(255,255,255)");
        sheet.fill_rect(x, picture_top, grid.cell_width as f32, cell_height as f32);
        sheet.draw_image(bitmap, x, picture_top);
        sheet.set_stroke_color("rgb(180,185,195)");
        sheet.stroke_rect(x, picture_top, *image_width as f32, *image_height as f32);
    }
    let png = sheet.to_png().map_err(|error| error.to_string())?;
    Ok(Sheet { width: sheet_width, height: sheet_height, png })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thirteen_pages_make_seven_sheets_of_two() {
        let pages: Vec<usize> = (1..=13).collect();
        let groups = page_groups(&pages);
        assert_eq!(groups.len(), 7);
        assert_eq!(groups[0], [1, 2]);
        assert_eq!(groups[6], [13]);
    }

    #[test]
    fn no_render_has_more_than_twelve_sheets() {
        for count in [13usize, 24, 25, 100, 101, 500] {
            let pages: Vec<usize> = (1..=count).collect();
            assert!(page_groups(&pages).len() <= MAX_RENDER_IMAGES, "{count} pages");
            assert_eq!(page_groups(&pages).concat(), pages);
        }
    }

    #[test]
    fn the_grid_widens_with_the_pages() {
        assert_eq!(grid(1, 1400.0), Grid { columns: 1, rows: 1, cell_width: 1400 - 24 });
        assert_eq!(grid(2, 1400.0).columns, 1);
        assert_eq!(grid(3, 1400.0).columns, 2);
        assert_eq!(grid(8, 1400.0).columns, 3);
        let nine = grid(9, 1400.0);
        assert_eq!((nine.columns, nine.rows, nine.cell_width), (3, 3, (1400 - 4 * 12) / 3));
        assert_eq!(grid(13, 200.0).cell_width, MIN_CELL_WIDTH);
    }

    #[test]
    fn a_sheet_is_at_least_256_wide_and_an_unusable_width_is_1400() {
        assert_eq!(sheet_width(200.0), 256.0);
        assert_eq!(sheet_width(f64::NAN), 1400.0);
        assert_eq!(sheet_width(0.0), 1400.0);
        assert_eq!(sheet_width(900.5), 900.5);
    }
}
