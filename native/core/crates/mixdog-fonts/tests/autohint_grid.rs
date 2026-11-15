//! The vertical grid fitting of the auto-hinter model against what FreeType's light auto-hinter left in the pixels Skia drew
//! (`native/core/fixtures/office-canvas/golden.json`, case `text_latin`: "Hello, World 123" in `Noto Sans Lisu` at 20 px with its
//! baseline on a pixel row). The rows the recorded glyphs fill are the expected positions: the capital `H` is 14 rows high
//! and its crossbar has its top edge on a pixel boundary at 8 rows, the lower-case `l` is 15 rows high, an `x` 11.

use mixdog_fonts::Face;
use mixdog_fonts::autohint;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;

fn lisu() -> Face {
    let path = twin::repo_root().join("native/core/fixtures/office-measure/faces/NotoSansLisu-Regular.ttf");
    Face::from_file(&Unlaned, &path).expect("the fixture face")
}

fn hinted_rows(face: &Face, character: char, ppem: i64) -> Vec<(f32, f32)> {
    let parsed = face.parsed().expect("parsed");
    let metrics = autohint::metrics_of(face).expect("metrics");
    let glyph = parsed.glyph_index(character).expect("a glyph").0;
    let hinted = metrics.hint(&parsed, glyph, ppem * 64, ppem * 64).expect("an outline");
    hinted.contours.iter().flatten().map(|point| (point.0, point.1)).collect()
}

fn extent(points: &[(f32, f32)]) -> (f32, f32) {
    points.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), point| (low.min(point.1), high.max(point.1)))
}

#[test]
fn the_capital_the_ascender_and_the_x_height_land_on_the_rows_skia_filled() {
    let face = lisu();
    assert_eq!(extent(&hinted_rows(&face, 'H', 20)), (0.0, 14.0), "H is 14 rows high");
    assert_eq!(extent(&hinted_rows(&face, 'l', 20)).1, 15.0, "l is 15 rows high");
    assert_eq!(extent(&hinted_rows(&face, 'x', 20)).1, 11.0, "x is 11 rows high");
}

#[test]
fn the_crossbar_of_h_has_its_top_on_a_pixel_boundary_and_keeps_its_width() {
    let face = lisu();
    let mut levels: Vec<f32> = hinted_rows(&face, 'H', 20).into_iter().map(|point| point.1).filter(|y| *y > 0.0 && *y < 14.0).collect();
    levels.sort_by(f32::total_cmp);
    levels.dedup();
    assert_eq!(levels.len(), 2, "the two edges of the crossbar: {levels:?}");
    assert_eq!(levels[1], 8.0, "the top edge is on a pixel boundary");
    let width = levels[1] - levels[0];
    assert!((width - 1.59).abs() < 0.02, "the stem keeps the width of the outline (79 units scaled by 1.0073): {width}");
}

#[test]
fn nothing_moves_across() {
    let face = lisu();
    let parsed = face.parsed().expect("parsed");
    let glyph = parsed.glyph_index('H').expect("a glyph").0;
    let plain = autohint::scaled_outline(&parsed, glyph, 20.0 / 1000.0, 20.0 / 1000.0).expect("an outline");
    let hinted = hinted_rows(&face, 'H', 20);
    for (before, after) in plain.contours.iter().flatten().zip(&hinted) {
        assert!((before.0 - after.0).abs() <= 1.0 / 64.0, "{before:?} {after:?}");
    }
}

#[test]
fn the_cjk_fallback_notdef_fits_horizontally_in_light_mode() {
    let face = lisu();
    let parsed = face.parsed().expect("parsed");
    let metrics = autohint::metrics_of(&face).expect("metrics");
    let hinted = metrics.hint_script(&parsed, 0, 16 * 64, 16 * 64, autohint::Script::Cjk).expect("notdef");
    let right = hinted.contours.iter().flatten().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max).ceil();
    // Isolated canvas oracle: 16px Twin Lisu "안녕" right 17.600021362304688,
    // minus the .notdef advance 9.600021362304688. The unhinted box rounds to 9.
    assert_eq!(right, 8.0);
}
