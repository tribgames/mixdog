//! The Rust transcript scroll engine against what the Node one does (tests/goldens/scroll.json, recorded by
//! tests/recorders/record-scroll.mjs): the `MIXDOG_TUI_SCROLL_*` tuning and the wheel acceleration, the reading anchor
//! arithmetic, the render-time lock and the post-commit reconciliation over seeded states, scripted scroll sequences (manual
//! scroll, glide, history paging, blocked read-back, coalesced wheel), the swap reset and the activity signatures; and the
//! port of `use-transcript-scroll.test.mjs` and `use-transcript-activity.test.mjs` (the selection tests of the first belong to
//! the mouse module).

use mixdog_tui::transcript::scroll::anchor::{Anchor, Geometry, reading_anchor_at};
use mixdog_tui::transcript::scroll::coalesce::ScrollCoalescer;
use mixdog_tui::transcript::scroll::engine::{ScrollHost, TranscriptScroll};
use mixdog_tui::transcript::scroll::lock::{CommitFrame, RowIndex};
use mixdog_tui::transcript::scroll::tuning::{ScrollTuning, WheelAccel};
use serde_json::json;

/// A host that records the history restores and has no selection.
#[derive(Default)]
struct Host {
    before: bool,
    after: bool,
    restores: bool,
    older: usize,
    newer: usize,
}

impl ScrollHost for Host {
    fn history_before(&self) -> bool {
        self.before
    }
    fn history_after(&self) -> bool {
        self.after
    }
    fn restore_older(&mut self) -> bool {
        self.older += 1;
        self.restores
    }
    fn restore_newer(&mut self) -> bool {
        self.newer += 1;
        self.restores
    }
}

fn host() -> Host {
    Host { restores: true, ..Host::default() }
}

fn geometry_of(heights: &[usize], view: usize) -> Geometry {
    let mut rows = vec![0];
    for height in heights {
        rows.push(rows.last().copied().unwrap_or(0) + height);
    }
    Geometry {
        total_rows: *rows.last().unwrap_or(&0),
        ids: (0..heights.len()).map(|index| json!(format!("i{index}"))).collect(),
        prefix_rows: Some(rows),
        view_rows: view,
        render_offset: 0.0,
    }
}

/// The scroll state of a ten-item, hundred-row transcript in a ten-row viewport, following the tail.
fn transcript(heights: &[usize], view: usize) -> TranscriptScroll {
    let geom = geometry_of(heights, view);
    TranscriptScroll { max_scroll_rows: geom.total_rows.saturating_sub(view), following: true, geom, ..TranscriptScroll::default() }
}

#[test]
fn defaults_are_the_documented_ones() {
    let tuning = ScrollTuning::default();
    assert_eq!((tuning.coalesce_ms, tuning.step_rows, tuning.step_max_rows, tuning.accel_idle_ms), (16, 3, 9, 150));
    assert!(tuning.accel_enabled);
}

// ── use-transcript-scroll.test.mjs ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn manual_scroll_captures_the_anchor_and_a_near_bottom_scroll_snaps_back_to_the_tail() {
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    scroll.scroll_rows(&mut host, 3.0, false);
    assert_eq!((scroll.target, scroll.position, scroll.following), (3.0, 3.0, false));
    assert_eq!(scroll.anchor, Some(Anchor { id: json!("i8"), offset: 7.0 }));
    assert!(!scroll.anchor_dirty);
    assert_eq!(scroll.scroll_offset, 3);

    scroll.scroll_rows(&mut host, -1.0, false);
    assert_eq!(scroll.target, 0.0, "within the snap band the target lands on 0");
    assert!(scroll.following);
    assert_eq!(scroll.anchor, None);
    assert_eq!(scroll.scroll_offset, 0);

    scroll.scroll_rows(&mut host, 4.0, true);
    assert_eq!(scroll.target, 4.0);
    assert_eq!(scroll.scroll_offset, 0, "a smooth scroll publishes through the glide, not synchronously");
    assert!(scroll.glide_running());
    while scroll.glide_tick() {}
    assert_eq!((scroll.position, scroll.scroll_offset), (4.0, 4));
    assert!(!scroll.following, "landing above the tail leaves follow off");

    scroll.reset_transcript_scroll();
    assert_eq!((scroll.target, scroll.scroll_offset), (0.0, 0));
    assert!(scroll.following);
}

#[test]
fn an_upward_intent_blocked_by_a_zero_committed_max_is_replayed_once_the_max_is_available() {
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    scroll.max_scroll_rows = 0;
    scroll.scroll_rows(&mut host, 5.0, false);
    assert_eq!(scroll.target, 0.0);
    assert!(!scroll.following, "the blocked intent still cancels follow");
    scroll.max_scroll_rows = 90;
    scroll.replay_pending_readback(&mut host);
    assert_eq!(scroll.target, 5.0, "the preserved readback rows are applied");
    assert_eq!(scroll.anchor, Some(Anchor { id: json!("i8"), offset: 5.0 }));
}

#[test]
fn scrolling_past_either_edge_pages_transcript_history_after_capturing_a_restore_anchor() {
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    host.before = true;
    scroll.target = 90.0;
    scroll.scroll_rows(&mut host, 1.0, false);
    assert_eq!(host.older, 1);
    assert_eq!(scroll.anchor, Some(Anchor { id: json!("i0"), offset: 0.0 }));
    assert_eq!(scroll.target, 90.0, "paging older does not move the target");
    assert!(!scroll.following);

    host.before = false;
    host.after = true;
    scroll.target = 0.0;
    scroll.scroll_rows(&mut host, -1.0, false);
    assert_eq!(host.newer, 1);
    assert_eq!(scroll.target, 90.0, "paging newer keeps a positive anchored target");
    assert_eq!(scroll.scroll_offset, 90);
}

#[test]
fn coalesced_wheel_deltas_flush_as_one_scroll_per_tick() {
    let tuning = ScrollTuning::default();
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    let mut coalescer = ScrollCoalescer::default();
    for rows in [2.0, 2.0] {
        if let Some(flushed) = coalescer.queue(rows, 0, tuning.coalesce_ms) {
            scroll.scroll_rows(&mut host, flushed, false);
        }
    }
    assert_eq!(scroll.target, 2.0, "the first delta flushes immediately");
    assert_eq!(coalescer.deadline(), Some(16));
    assert_eq!(coalescer.tick(15), None, "the window is still open");
    scroll.scroll_rows(&mut host, coalescer.tick(16).expect("the rest flushes on the tick"), false);
    assert_eq!(scroll.target, 4.0);
    scroll.arm_transcript_follow();
    assert!(scroll.following);
    assert_eq!(scroll.anchor, None);
}

#[test]
fn manual_and_render_time_anchor_capture_preserve_row_boundaries_clamps_and_missing_geometry() {
    let prefix_rows = [0, 2, 5, 9];
    let items = [json!("a"), json!("b"), json!("c")];
    let at = |target: f64| reading_anchor_at(Some(&prefix_rows), &items, 9, 3, target);
    let found = |id: &str, offset: f64| Some(Anchor { id: json!(id), offset });
    assert_eq!(at(0.0), found("c", 1.0));
    assert_eq!(at(1.0), found("c", 0.0));
    assert_eq!(at(1.5), found("b", 2.5));
    assert_eq!(at(-4.0), found("c", 1.0));
    assert_eq!(at(99.0), found("a", 0.0));
    assert_eq!(reading_anchor_at(None, &items, 9, 3, 0.0), None);
    assert_eq!(reading_anchor_at(Some(&[0]), &items, 9, 3, 0.0), None);
    assert_eq!(reading_anchor_at(Some(&prefix_rows), &[], 9, 3, 0.0), None);
    assert_eq!(reading_anchor_at(Some(&prefix_rows), &[json!(0)], 9, 3, 99.0), Some(Anchor { id: json!(0), offset: 0.0 }));
    assert_eq!(reading_anchor_at(Some(&[0, 0, 2]), &[json!("a"), json!("b")], 2, 1, 1.0), found("b", 0.0));
}

// ── what the golden does not reach ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_anchor_lock_keeps_the_top_item_still_when_an_item_above_grows() {
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    scroll.scroll_rows(&mut host, 30.0, false);
    let locked = scroll.anchor.clone().expect("a reading anchor");
    assert_eq!(locked, Anchor { id: json!("i6"), offset: 0.0 });
    // The first item grows by four rows: the anchored item starts four rows lower and the target follows it.
    let grown = geometry_of(&[14, 10, 10, 10, 10, 10, 10, 10, 10, 10], 10);
    let offset = scroll.resolve_render_scroll_offset(&grown.ids, RowIndex { total_rows: grown.total_rows, prefix_rows: grown.prefix_rows.as_deref() }, 10, 0);
    assert_eq!(offset, 30.0, "the item at the top stays at the top: the rows below it did not change");
    let shrunk_below = geometry_of(&[10, 10, 10, 10, 10, 10, 10, 10, 10, 20], 10);
    let offset = scroll.resolve_render_scroll_offset(
        &shrunk_below.ids,
        RowIndex { total_rows: shrunk_below.total_rows, prefix_rows: shrunk_below.prefix_rows.as_deref() },
        10,
        0,
    );
    assert_eq!(offset, 40.0, "rows appended below the anchor raise the bottom-relative offset");
}

fn commit_frame(grown: &Geometry, previous_total_rows: usize) -> CommitFrame<'_> {
    CommitFrame {
        drag_active: false,
        total_rows: grown.total_rows,
        previous_total_rows,
        prefix_rows: grown.prefix_rows.as_deref(),
        ids: &grown.ids,
        view_rows: 10,
        max_rows: grown.total_rows - 10,
    }
}

#[test]
fn a_streaming_tail_is_followed_only_while_armed() {
    let mut scroll = transcript(&[10; 10], 10);
    let mut host = host();
    let grown = geometry_of(&[10, 10, 10, 10, 10, 10, 10, 10, 10, 13], 10);
    scroll.sync_reading_anchor_after_commit(&commit_frame(&grown, 100));
    assert_eq!((scroll.target, scroll.following), (0.0, true), "an armed follow stays on the tail");
    scroll.scroll_rows(&mut host, 20.0, false);
    assert!(!scroll.following);
    scroll.sync_reading_anchor_after_commit(&commit_frame(&grown, 103));
    assert_eq!(scroll.target, 23.0, "a reader keeps the row at the viewport top: the offset rises by the three rows of growth");
}

#[test]
fn bulk_replacement_returns_to_the_live_tail() {
    let mut scroll = TranscriptScroll::default();
    scroll.swap_reset(&[json!("a"), json!("b")]);
    scroll.following = false;
    scroll.target = 7.0;
    scroll.swap_reset(&[json!("a"), json!("b"), json!("c")]);
    assert_eq!(scroll.target, 7.0, "a live append keeps the position");
    scroll.swap_reset(&[json!("z"), json!("b"), json!("c")]);
    assert_eq!((scroll.target, scroll.following), (0.0, true), "a changed head is a bulk swap");
}

#[test]
fn the_glide_eases_toward_the_target_and_drops_follow_only_above_the_tail() {
    let mut scroll = transcript(&[10; 10], 10);
    scroll.following = true;
    scroll.target = 10.0;
    scroll.start_smooth_scroll();
    assert!(scroll.glide_tick());
    assert!((scroll.position - 3.2).abs() < 1e-9 && scroll.scroll_offset == 3);
    while scroll.glide_tick() {}
    assert_eq!((scroll.position, scroll.following), (10.0, false));
    scroll.following = true;
    scroll.target = 0.0;
    scroll.start_smooth_scroll();
    while scroll.glide_tick() {}
    assert!(scroll.following, "landing at the tail keeps an armed follow");
    assert!(!scroll.glide_tick(), "no glide runs");
}

#[test]
fn tuning_parses_javascript_number_spellings() {
    let tuning = |name: &'static str, value: &'static str| ScrollTuning::from_lookup(move |key| (key == name).then(|| value.to_owned()));
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "0x10").step_rows, 16);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "1e1").step_rows, 10);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", " 7 ").step_rows, 7);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "2.9").step_rows, 2);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "-3").step_rows, 3);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "nan").step_rows, 3);
    assert_eq!(tuning("MIXDOG_TUI_SCROLL_SPEED", "inf").step_rows, 3);
    assert!(!tuning("MIXDOG_TUI_SCROLL_ACCELERATION", " Off ").accel_enabled);
    assert!(tuning("MIXDOG_TUI_SCROLL_ACCELERATION", "maybe").accel_enabled);
}

#[test]
fn the_maximum_step_defaults_to_three_notches_and_never_falls_below_one() {
    let with = |pairs: &'static [(&'static str, &'static str)]| {
        ScrollTuning::from_lookup(move |key| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| (*value).to_owned()))
    };
    let defaults = with(&[]);
    assert_eq!((defaults.coalesce_ms, defaults.step_rows, defaults.step_max_rows, defaults.accel_idle_ms), (16, 3, 9, 150));
    assert!(defaults.accel_enabled);
    assert_eq!(with(&[("MIXDOG_TUI_SCROLL_SPEED", "5")]).step_max_rows, 15, "three notches of the chosen speed");
    assert_eq!(with(&[("MIXDOG_TUI_SCROLL_SPEED", "5"), ("MIXDOG_TUI_SCROLL_SPEED_MAX", "4")]).step_max_rows, 5, "never below the base step");
    assert_eq!(with(&[("MIXDOG_TUI_SCROLL_SPEED_MAX", "20")]).step_max_rows, 20);
    assert_eq!(with(&[("MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS", "0")]).accel_idle_ms, 150, "a value under one is not a setting");
}

#[test]
fn consecutive_notches_in_one_direction_speed_up_to_the_maximum_and_a_pause_or_turn_resets_them() {
    let tuning = ScrollTuning::default();
    let mut wheel = WheelAccel::new(&tuning);
    assert_eq!(wheel.notch(1, 1_000, &tuning), 3, "the first notch is the base step");
    assert_eq!(wheel.notch(1, 1_050, &tuning), 6);
    assert_eq!(wheel.notch(1, 1_100, &tuning), 9);
    assert_eq!(wheel.notch(1, 1_150, &tuning), 9, "the step stops at the maximum");
    assert_eq!(wheel.notch(1, 1_301, &tuning), 3, "a gap over the idle time starts again");
    assert_eq!(wheel.notch(1, 1_350, &tuning), 6);
    assert_eq!(wheel.notch(-1, 1_360, &tuning), -3, "the other direction starts again, with its own sign");
}

#[test]
fn with_acceleration_off_every_notch_is_the_base_step() {
    let tuning = ScrollTuning::from_lookup(|key| (key == "MIXDOG_TUI_SCROLL_ACCELERATION").then(|| "off".to_owned()));
    let mut wheel = WheelAccel::new(&tuning);
    let steps: Vec<i64> = (0..4).map(|n| wheel.notch(-1, 1_000 + n * 10, &tuning)).collect();
    assert_eq!(steps, [-3, -3, -3, -3]);
}
