//! The Rust transcript window against what the Node one does (tests/goldens/window.json, recorded by
//! tests/recorders/record-window.mjs): `transcriptRenderWindow` over generated row tables, `resolveAnchorScrollOffset`,
//! `transcriptSwapReturnsToTail` and the selection helpers; and the behaviours of `use-transcript-window.test.mjs` that do not
//! need Ink (the shared selection geometry, the streaming high-water rows, the expanded aggregate rows, following the tail and
//! holding the reading anchor while rows grow), over heights that come from the widgets.

use std::collections::HashSet;

use mixdog_tui::transcript::window::geometry::FrameProps;
use mixdog_tui::transcript::window::heights::{HeightParams, ItemHeights};
use mixdog_tui::transcript::window::instance_state::WindowState;
use mixdog_tui::transcript::window::render_window::{
    AnchorPoint, WindowTuning, resolve_anchor_scroll_offset, transcript_render_window, transcript_swap_returns_to_tail, upper_bound,
};
use mixdog_tui::transcript::window::row_index::{Items, RowIndex};
use mixdog_tui::transcript::window::selection_shift::{
    Cell, SelectionRect, compare_cell_order, selection_rect_is_degenerate, selection_rects_equal, shift_selection_rect_y,
    status_band_row_range, transcript_viewport_row_range,
};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/window.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

fn count(value: &Value) -> usize {
    value.as_u64().expect("a count") as usize
}

fn row_index(rows: &[usize]) -> RowIndex {
    let mut prefix_rows = vec![0];
    for row in rows {
        prefix_rows.push(prefix_rows.last().copied().unwrap_or(0) + row);
    }
    RowIndex { rows: rows.to_vec(), total_rows: prefix_rows.last().copied().unwrap_or(0), prefix_rows }
}

fn rows_of(value: &Value) -> Vec<usize> {
    value.as_array().expect("rows").iter().map(count).collect()
}

fn items_of(count: usize) -> Vec<Value> {
    (0..count).map(|index| json!({"id": format!("i{index}"), "kind": "user"})).collect()
}

#[test]
fn render_windows_match_node() {
    let golden = golden();
    let tuning = WindowTuning::default();
    let mut checked = 0;
    for table in golden["windows"].as_array().expect("windows") {
        let index = row_index(&rows_of(&table["rows"]));
        for case in table["cases"].as_array().expect("cases") {
            let window = transcript_render_window(&index, number(&case["offset"]), number(&case["view"]), &tuning);
            let got = [window.start_index, window.end_index, window.bottom_spacer_rows, window.total_rows, window.max_scroll_rows, window.effective_scroll_offset];
            let want: Vec<usize> = case["out"].as_array().expect("out").iter().map(count).collect();
            assert_eq!(got.to_vec(), want, "{} table of {} items, view {}, offset {}", table["kind"], index.rows.len(), case["view"], case["offset"]);
            checked += 1;
        }
    }
    assert!(checked > 1000);
}

#[test]
fn anchors_resolve_as_in_node() {
    let golden = golden();
    for case in golden["anchors"].as_array().expect("anchors") {
        let rows = rows_of(&case["rows"]);
        let index = row_index(&rows);
        let settled = items_of(count(&case["count"]));
        let items = Items::new(&settled, None);
        let anchor = case["anchor"].as_object().map(|anchor| AnchorPoint { id: anchor["id"].as_str().expect("id").to_owned(), offset: count(&anchor["offset"]) });
        let got = resolve_anchor_scroll_offset(anchor.as_ref(), &items, &index.prefix_rows, count(&case["totalRows"]), count(&case["view"]), count(&case["maxRows"]));
        let want = case["out"].as_u64().map(|offset| offset as usize);
        assert_eq!(got, want, "{case}");
    }
}

#[test]
fn swaps_return_to_the_tail_as_in_node() {
    let golden = golden();
    for case in golden["swaps"].as_array().expect("swaps") {
        let got = transcript_swap_returns_to_tail(count(&case["count"]), count(&case["previousCount"]), case["firstId"].as_str(), case["previousFirstId"].as_str());
        assert_eq!(Some(got), case["out"].as_bool(), "{case}");
    }
}

fn rect_of(value: &Value) -> SelectionRect {
    let int = |key: &str| value[key].as_i64().expect("a coordinate");
    SelectionRect {
        mode: value["mode"].as_str().map(str::to_owned),
        x1: int("x1"),
        y1: int("y1"),
        x2: int("x2"),
        y2: int("y2"),
        clip_y1: value["clipY1"].as_i64(),
        clip_y2: value["clipY2"].as_i64(),
        capture_text: value["captureText"].as_bool(),
    }
}

fn cell_of(value: &Value) -> Cell {
    Cell { x: value["x"].as_i64().expect("x"), y: value["y"].as_i64().expect("y") }
}

#[test]
fn selection_helpers_match_node() {
    let golden = golden();
    let selection = &golden["selection"];
    for case in selection["degenerate"].as_array().expect("degenerate") {
        assert_eq!(Some(selection_rect_is_degenerate(&rect_of(&case["rect"]))), case["out"].as_bool(), "{case}");
    }
    for case in selection["equal"].as_array().expect("equal") {
        assert_eq!(Some(selection_rects_equal(Some(&rect_of(&case["a"])), Some(&rect_of(&case["b"])))), case["out"].as_bool(), "{case}");
    }
    for case in selection["shift"].as_array().expect("shift") {
        let got = shift_selection_rect_y(Some(&rect_of(&case["rect"])), number(&case["delta"]));
        assert_eq!(got, Some(rect_of(&case["out"])), "{case}");
    }
    for case in selection["shiftNone"].as_array().expect("shiftNone") {
        assert_eq!(shift_selection_rect_y(None, number(&case["delta"])), None);
    }
    for case in selection["compare"].as_array().expect("compare") {
        assert_eq!(Some(i64::from(compare_cell_order(cell_of(&case["a"]), cell_of(&case["b"])))), case["out"].as_i64(), "{case}");
    }
    for case in selection["viewport"].as_array().expect("viewport") {
        let got = transcript_viewport_row_range(case["top"].as_f64(), case["bottom"].as_f64());
        assert_eq!((got.top, got.bottom), (case["out"]["top"].as_i64().expect("top"), case["out"]["bottom"].as_i64().expect("bottom")), "{case}");
    }
    for case in selection["band"].as_array().expect("band") {
        let got = status_band_row_range(number(&case["frameRows"]), count(&case["band"]));
        assert_eq!((got.top, got.bottom), (case["out"]["top"].as_i64().expect("top"), case["out"]["bottom"].as_i64().expect("bottom")), "{case}");
    }
}

fn params(columns: usize, tool_output_expanded: bool) -> HeightParams {
    HeightParams { columns, tool_output_expanded }
}

#[test]
fn streaming_estimates_trim_boundary_newlines_and_retain_high_water_rows_only_until_pruning_or_settlement() {
    let mut heights = ItemHeights::default();
    heights.prune_streaming(&HashSet::new());
    let short = json!({"id": "row-estimate-stream", "kind": "assistant", "streaming": true, "text": "\nalpha\n"});
    let long = json!({"id": "row-estimate-stream", "kind": "assistant", "streaming": true, "text": "\nalpha\nbeta\ngamma\n"});
    assert_eq!(heights.rows(&short, None, &params(80, false)), 2);
    assert_eq!(heights.rows(&long, None, &params(80, false)), 4);
    assert_eq!(heights.rows(&short, None, &params(80, false)), 4, "a streaming message never shrinks");
    heights.prune_streaming(&HashSet::from(["row-estimate-stream".to_owned()]));
    assert!(heights.has_streaming_state_to_prune());
    heights.prune_streaming(&HashSet::new());
    assert!(!heights.has_streaming_state_to_prune());
    assert_eq!(heights.rows(&short, None, &params(80, false)), 2);
    let settled = json!({"id": "row-estimate-stream", "kind": "assistant", "streaming": false, "text": "\nalpha\n"});
    heights.rows(&settled, None, &params(80, false));
    assert!(!heights.has_streaming_state_to_prune(), "a settled message forgets its water line");
}

#[test]
fn a_new_width_resets_the_streaming_water_line() {
    let mut heights = ItemHeights::default();
    let words = vec!["word"; 60].join(" ");
    let live = json!({"id": "w", "kind": "assistant", "streaming": true, "text": words});
    let narrow = heights.rows(&live, None, &params(30, false));
    let wide = heights.rows(&live, None, &params(200, false));
    assert!(narrow > wide, "the row count legitimately falls with a wider terminal");
}

#[test]
fn expanded_aggregate_rows_distinguish_pending_raw_body_and_summary_only_cards() {
    let item = json!({
        "id": "aggregate-rows", "kind": "tool", "name": "read", "aggregate": true, "count": 2, "completedCount": 2,
        "result": "summary", "rawResult": "first\nsecond"
    });
    let mut heights = ItemHeights::default();
    assert_eq!(heights.rows(&item, None, &params(80, true)), 4, "margin, header, and two body rows");
    assert_eq!(heights.rows(&item, None, &params(80, false)), 3, "collapsed cards keep one detail row");
    let mut no_raw = item.clone();
    no_raw["rawResult"] = Value::Null;
    assert_eq!(heights.rows(&no_raw, None, &params(80, true)), 3);
    let mut blank_raw = item;
    blank_raw["rawResult"] = json!(" \n");
    assert_eq!(heights.rows(&blank_raw, None, &params(80, true)), 3);
}

#[test]
fn a_user_message_after_a_user_message_stacks_flush() {
    let mut heights = ItemHeights::default();
    let user = json!({"id": "u", "kind": "user", "text": "hello"});
    let apart = heights.rows(&user, Some("assistant"), &params(40, false));
    let flush = heights.rows(&user, Some("user"), &params(40, false));
    assert_eq!(apart, flush + 1);
}

#[test]
fn an_item_that_draws_nothing_still_takes_one_row_and_a_notice_two() {
    let mut heights = ItemHeights::default();
    assert_eq!(heights.rows(&Value::Null, None, &params(40, false)), 1);
    assert_eq!(heights.rows(&json!({"id": "x", "kind": "unknown"}), None, &params(40, false)), 1);
    assert_eq!(heights.rows(&json!({"id": "n", "kind": "notice", "text": "careful"}), None, &params(40, false)), 2);
}

#[test]
fn a_height_is_the_same_whatever_the_clock_and_a_cached_lines_set_is_reused() {
    let mut heights = ItemHeights::default();
    let item = json!({"id": "n", "kind": "notice", "text": "a notice that wraps over a narrow terminal for sure"});
    let first = heights.lines(&item, None, &params(20, false), 0, 1.0);
    let second = heights.lines(&item, None, &params(20, false), 0, 99_999.0);
    assert!(std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(first.len(), heights.rows(&item, None, &params(20, false)));
    let narrower = heights.lines(&item, None, &params(12, false), 0, 1.0);
    assert!(narrower.len() > first.len());
}

fn many_users(count: usize) -> Vec<Value> {
    (0..count).map(|index| json!({"id": format!("u{index}"), "kind": "user", "text": format!("line {index}")})).collect()
}

fn frame_props(settled: &[Value], revision: u64, scroll_offset: f64) -> FrameProps<'_> {
    FrameProps { settled, structure_revision: revision, streaming_tail: None, columns: 40, tool_output_expanded: false, content_height: 6, floating_panel_rows: 0, scroll_offset }
}

/// The item at the viewport top for a frame with `total` rows scrolled `offset` rows up.
fn top_item(index: &RowIndex, offset: usize, view: usize) -> usize {
    let top_row = index.total_rows.saturating_sub(offset + view);
    upper_bound(&index.prefix_rows, top_row).saturating_sub(1)
}

#[test]
fn the_window_follows_the_tail_then_holds_the_reading_anchor_while_rows_grow() {
    let tuning = WindowTuning::default();
    let mut state = WindowState::new("session-1");
    let first = many_users(200);
    let frame = state.frame(&frame_props(&first, 1, 0.0), &tuning, |_, offset| offset);
    assert_eq!(frame.window.effective_scroll_offset, 0, "a fresh transcript is pinned to the bottom");
    assert_eq!(frame.window.end_index, 200);

    let appended = many_users(205);
    let frame = state.frame(&frame_props(&appended, 2, 0.0), &tuning, |_, offset| offset);
    assert_eq!((frame.window.effective_scroll_offset, frame.window.end_index), (0, 205), "bottom-follow reveals appended rows");

    // A manual scroll up by 3 rows captures the reading anchor from the published geometry.
    let scrolled = state.frame(&frame_props(&appended, 2, 3.0), &tuning, |_, offset| offset);
    assert_eq!(scrolled.window.effective_scroll_offset, 3);
    assert!(scrolled.window.max_scroll_rows >= 3);
    let index = state.row_index().clone();
    let anchored_item = top_item(&index, 3, 6);
    let anchor_row = index.total_rows - 3 - 6;
    let anchor = AnchorPoint { id: format!("u{anchored_item}"), offset: anchor_row - index.prefix_rows[anchored_item] };

    // Ten rows more arrive below: the anchor lock gives the offset that keeps the top item where it was.
    let grown = many_users(210);
    let settled = grown.clone();
    let held = state.frame(&frame_props(&grown, 3, 3.0), &tuning, |index, _| {
        let items = Items::new(&settled, None);
        let view = 6;
        resolve_anchor_scroll_offset(Some(&anchor), &items, &index.prefix_rows, index.total_rows, view, index.total_rows.saturating_sub(view)).map_or(3.0, |offset| offset as f64)
    });
    let index = state.row_index();
    assert_eq!(top_item(index, held.window.effective_scroll_offset, 6), anchored_item, "growth below the anchor leaves the top row in place");
    assert!(held.window.effective_scroll_offset > 3);

    // Back to the tail: the newest rows are pinned again and the committed maximum reaches the oldest row.
    let tail = state.frame(&frame_props(&grown, 3, 0.0), &tuning, |_, offset| offset);
    assert_eq!((tail.window.effective_scroll_offset, tail.window.end_index), (0, 210));
    assert!(tail.max_scroll_rows >= 210 - 6);
}

#[test]
fn a_session_switch_never_lends_the_old_rows_to_the_new_transcript() {
    let tuning = WindowTuning::default();
    let mut state = WindowState::new("one");
    let old = many_users(100);
    state.frame(&frame_props(&old, 5, 0.0), &tuning, |_, offset| offset);
    assert_eq!(state.commit_total_rows(150), 0);
    assert!(state.switch_session("two"));
    let new = many_users(3);
    let frame = state.frame(&frame_props(&new, 5, 0.0), &tuning, |_, offset| offset);
    assert_eq!(state.row_index().rows.len(), 3);
    assert_eq!(frame.window.end_index, 3);
    assert_eq!(state.commit_total_rows(frame.geometry.total_rows), 0);
}
