//! The selection against what the Ink fork does over the same frames (tests/goldens/selection.json, recorded by
//! tests/recorders/record-selection.mjs): the word and line rectangles of every cell, the per-row harvest and the text
//! of every recorded selection rectangle, the cells of the frame Ink wrote with the highlight in it, and the colour
//! downgrade of the frame writer at chalk levels 1 and 2 (the recorded frames are `FORCE_COLOR=3`, 2 and 1).
//!
//! A frame is read back into a grid with [`grid_from_ink_frame_with`]; the recorded frame with no selection is the grid
//! the Rust code works on.

use mixdog_term::frame::{Color, FrameWriter, Grid, Style};
use mixdog_term::selection::{
    CellSpan, DEFAULT_SELECTION_BACKGROUND, SelectionMode, SelectionRect, SelectionState, line_rect_at, selection_background,
    word_rect_at,
};
use mixdog_term::testing::{VtGrid, grid_from_ink_frame_with};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/selection.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn int(value: &Value) -> i32 {
    value.as_i64().expect("an integer") as i32
}

fn rect_from(value: &Value) -> SelectionRect {
    let mode = if value["mode"] == "linear" { SelectionMode::Linear } else { SelectionMode::Block };
    let mut rect = SelectionRect::new(mode, int(&value["x1"]), int(&value["y1"]), int(&value["x2"]), int(&value["y2"]));
    rect.clip_y1 = value.get("clipY1").and_then(Value::as_i64).map(|v| v as i32);
    rect.clip_y2 = value.get("clipY2").and_then(Value::as_i64).map(|v| v as i32);
    rect.capture_text = value.get("captureText") != Some(&Value::Bool(false));
    rect.background = value
        .get("selectionBackground")
        .and_then(Value::as_str)
        .map_or(DEFAULT_SELECTION_BACKGROUND, selection_background);
    rect
}

fn wide(golden: &Value) -> bool {
    golden["ambiguousWide"].as_bool().expect("ambiguousWide")
}

fn frame_grid(golden: &Value, frame: &Value, case: &Value) -> Grid {
    grid_from_ink_frame_with(frame.as_str().expect("frame"), case["width"].as_u64().expect("width") as u16, wide(golden))
}

fn plain_style(style: Style) -> Style {
    let plain = |color: Color| match color {
        Color::Literal(rgb) => Color::Rgb(rgb),
        other => other,
    };
    Style { fg: plain(style.fg), bg: plain(style.bg), ..style }
}

/// Every cell of two grids is the same glyph in the same style under the same link (a continuation cell only has to be
/// one: Ink writes no bytes for it, so its style cannot be read back from a frame).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!((actual.width, actual.height), (expected.width, expected.height), "{context}: size");
    for y in 0..actual.height {
        for x in 0..actual.width {
            let (a, e) = (actual.cell(x, y).unwrap(), expected.cell(x, y).unwrap());
            if a.is_continuation() || e.is_continuation() {
                assert_eq!(a.is_continuation(), e.is_continuation(), "{context}: continuation at ({x}, {y})");
                continue;
            }
            assert_eq!((a.text(), a.width), (e.text(), e.width), "{context}: glyph at ({x}, {y})");
            assert_eq!(plain_style(a.style), plain_style(e.style), "{context}: style at ({x}, {y})");
            assert_eq!(actual.link_url(a.link), expected.link_url(e.link), "{context}: link at ({x}, {y})");
        }
    }
}

fn span(value: &Value) -> Option<CellSpan> {
    (!value.is_null()).then(|| CellSpan { x1: int(&value["x1"]), y1: int(&value["y1"]), x2: int(&value["x2"]), y2: int(&value["y2"]) })
}

#[test]
fn word_and_line_rectangles_match_ink_on_every_cell() {
    let golden = golden();
    let mut checked = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let grid = frame_grid(&golden, &case["frame"], case);
        for row in case["words"].as_array().unwrap() {
            let y = int(&row["y"]);
            let spans = row["spans"].as_array().unwrap();
            for (x, at) in row["at"].as_array().unwrap().iter().enumerate() {
                let expected = usize::try_from(at.as_i64().unwrap()).ok().map(|index| CellSpan {
                    x1: int(&spans[index][0]),
                    y1: y,
                    x2: int(&spans[index][1]),
                    y2: y,
                });
                assert_eq!(word_rect_at(&grid, x as i32, y), expected, "{name}: word at ({x}, {y})");
                checked += 1;
            }
        }
        for probe in case["probes"].as_array().unwrap() {
            let (x, y) = (int(&probe[0]), int(&probe[1]));
            assert_eq!(word_rect_at(&grid, x, y), span(&probe[2]), "{name}: word probe ({x}, {y})");
        }
        for line in case["lines"].as_array().unwrap() {
            let y = int(&line["y"]);
            let expected = line["x2"].as_i64().map(|x2| CellSpan { x1: 0, y1: y, x2: x2 as i32, y2: y });
            assert_eq!(line_rect_at(&grid, y), expected, "{name}: line at {y}");
        }
    }
    assert!(checked > 800, "the corpus is read: {checked} cells");
}

#[test]
fn every_recorded_selection_harvests_and_paints_like_ink() {
    let golden = golden();
    let mut checked = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let soft_wrap: Vec<bool> = case["softWrap"].as_array().unwrap().iter().map(|v| v.as_bool().unwrap()).collect();
        for (at, selection) in case["selections"].as_array().unwrap().iter().enumerate() {
            let context = format!("{name} selection {at} {}", selection["rect"]);
            let mut grid = frame_grid(&golden, &case["frame"], case);
            let mut state = SelectionState::default();
            state.apply(&mut grid, &soft_wrap);
            state.set_selection(Some(rect_from(&selection["rect"])));
            state.apply(&mut grid, &soft_wrap);

            assert_eq!(state.selection_text(), selection["text"].as_str(), "{context}: text");
            let rows: Option<Vec<(i32, String, bool)>> = state
                .selection_rows()
                .map(|rows| rows.iter().map(|row| (row.y, row.text.clone(), row.soft_wrap)).collect());
            let expected_rows: Option<Vec<(i32, String, bool)>> = selection["rows"].as_array().map(|rows| {
                rows.iter()
                    .map(|row| (int(&row["y"]), row["text"].as_str().unwrap().to_owned(), row["sw"].as_bool().unwrap()))
                    .collect()
            });
            assert_eq!(rows, expected_rows, "{context}: rows");

            let painted = frame_grid(&golden, &selection["frame"], case);
            assert_same_grid(&grid, &painted, &context);
            checked += 1;
        }
    }
    assert!(checked >= 150, "the corpus is read: {checked} selections");
}

#[test]
fn the_frame_writer_downgrades_colours_like_chalk() {
    let golden = golden();
    let mut checked = 0;
    for case in golden["cases"].as_array().unwrap() {
        let Some(levels) = case.get("levels") else { continue };
        let name = case["name"].as_str().unwrap();
        let truecolor = frame_grid(&golden, &case["frame"], case);
        for (level, key) in [(1, "1"), (2, "2"), (3, "3")] {
            let expected = if level == 3 { truecolor.clone() } else { frame_grid(&golden, &levels[key], case) };
            let mut writer = FrameWriter::new(Vec::new(), level);
            writer.write_frame(&truecolor, None).unwrap();
            let mut screen = VtGrid::new(truecolor.width, truecolor.height);
            screen.feed(writer.get_ref());
            assert_same_grid(screen.grid(), &expected, &format!("{name} at colour level {level}"));
            checked += 1;
        }
    }
    assert_eq!(checked, 12);
}
