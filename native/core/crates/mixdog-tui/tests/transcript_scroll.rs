//! The Rust transcript scroll engine against what the Node one does (tests/goldens/scroll.json, recorded by
//! tests/recorders/record-scroll.mjs): the `MIXDOG_TUI_SCROLL_*` tuning and the wheel acceleration, the reading anchor
//! arithmetic, the render-time lock and the post-commit reconciliation over seeded states, scripted scroll sequences (manual
//! scroll, glide, history paging, blocked read-back, coalesced wheel), the swap reset and the activity signatures; and the
//! port of `use-transcript-scroll.test.mjs` and `use-transcript-activity.test.mjs` (the selection tests of the first belong to
//! the mouse module).

use mixdog_tui::transcript::scroll::activity::{ActiveTool, ActiveTools, active_tools, active_tools_signature, agent_revision, statusline_stats};
use mixdog_tui::transcript::scroll::anchor::{
    Anchor, Current, Geometry, bottom_snap_rows, reading_anchor_at, resolve_anchor_scroll_offset, swap_returns_to_tail,
};
use mixdog_tui::transcript::scroll::coalesce::{DirectionalDelta, ScrollCoalescer, accumulate_directional_scroll_delta};
use mixdog_tui::transcript::scroll::engine::{ScrollHost, TranscriptScroll, Viewport};
use mixdog_tui::transcript::scroll::lock::{CommitFrame, RowIndex};
use mixdog_tui::transcript::scroll::tuning::{ScrollTuning, WheelAccel};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/scroll.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value[key].as_array().unwrap_or_else(|| panic!("{key} is a list"))
}

fn number(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap_or_else(|| panic!("{key} is a number"))
}

fn count(value: &Value, key: &str) -> usize {
    value[key].as_u64().unwrap_or_else(|| panic!("{key} is a count")) as usize
}

fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}

fn prefix(value: &Value, key: &str) -> Option<Vec<usize>> {
    value[key].as_array().map(|rows| rows.iter().map(|row| row.as_u64().expect("a row") as usize).collect())
}

fn ids(value: &Value, key: &str) -> Vec<Value> {
    list(value, key).to_vec()
}

fn anchor(value: &Value) -> Option<Anchor> {
    value.is_object().then(|| Anchor { id: value["id"].clone(), offset: number(value, "offset") })
}

fn same_anchor(actual: &Option<Anchor>, expected: &Value, context: &str) {
    assert_eq!(*actual, anchor(expected), "{context}");
}

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

fn lookup(env: &Value) -> impl Fn(&str) -> Option<String> + '_ {
    move |name| env.get(name).and_then(Value::as_str).map(str::to_owned)
}

#[test]
fn tuning_reads_each_variable_like_node() {
    for case in list(&golden(), "tuning") {
        let tuning = ScrollTuning::from_lookup(lookup(&case["env"]));
        let expected = &case["values"];
        let context = format!("env {}", case["env"]);
        assert_eq!(tuning.coalesce_ms as f64, number(expected, "coalesceMs"), "{context}");
        assert_eq!(tuning.step_rows as f64, number(expected, "stepRows"), "{context}");
        assert_eq!(tuning.accel_enabled, flag(expected, "accelEnabled"), "{context}");
        assert_eq!(tuning.step_max_rows as f64, number(expected, "stepMaxRows"), "{context}");
        assert_eq!(tuning.accel_idle_ms as f64, number(expected, "accelIdleMs"), "{context}");
    }
}

#[test]
fn wheel_acceleration_matches_the_wheel_router() {
    for case in list(&golden(), "wheel") {
        let tuning = ScrollTuning::from_lookup(lookup(&case["env"]));
        for (burst, expected) in list(case, "bursts").iter().zip(list(case, "rows")) {
            let mut accel = WheelAccel::new(&tuning);
            let rows: Vec<i64> = burst
                .as_array()
                .expect("a burst")
                .iter()
                .map(|notch| accel.notch(notch[0].as_i64().expect("direction") as i32, notch[1].as_u64().expect("time"), &tuning))
                .collect();
            let expected: Vec<i64> = expected.as_array().expect("rows").iter().map(|row| row.as_i64().expect("a row")).collect();
            assert_eq!(rows, expected, "env {} burst {burst}", case["env"]);
        }
    }
}

#[test]
fn defaults_are_the_documented_ones() {
    let tuning = ScrollTuning::default();
    assert_eq!((tuning.coalesce_ms, tuning.step_rows, tuning.step_max_rows, tuning.accel_idle_ms), (16, 3, 9, 150));
    assert!(tuning.accel_enabled);
}

#[test]
fn reading_anchor_and_resolution_match_node() {
    let golden = golden();
    for case in list(&golden, "anchors") {
        let prefix_rows = prefix(case, "prefixRows");
        let actual = reading_anchor_at(prefix_rows.as_deref(), &ids(case, "ids"), count(case, "totalRows"), count(case, "viewRows"), number(case, "target"));
        same_anchor(&actual, &case["expected"], &format!("{case}"));
    }
    for case in list(&golden, "resolve") {
        let prefix_rows = prefix(case, "prefixRows");
        let list_ids = ids(case, "ids");
        let current = Current {
            ids: &list_ids,
            prefix_rows: prefix_rows.as_deref(),
            total_rows: count(case, "totalRows"),
            view_rows: count(case, "viewRows"),
            max_rows: count(case, "maxRows"),
        };
        let actual = resolve_anchor_scroll_offset(&Anchor { id: case["anchor"]["id"].clone(), offset: number(&case["anchor"], "offset") }, &current);
        assert_eq!(actual, case["expected"].as_f64(), "{case}");
    }
    for case in list(&golden, "snap") {
        assert_eq!(bottom_snap_rows(count(case, "viewRows")), count(case, "expected"));
    }
    for case in list(&golden, "swapReturns") {
        let actual = swap_returns_to_tail(count(case, "count"), count(case, "previousCount"), &case["firstId"], &case["previousFirstId"]);
        assert_eq!(actual, flag(case, "expected"), "{case}");
    }
}

#[test]
fn directional_accumulation_matches_node() {
    for case in list(&golden(), "coalesce") {
        let mut state = DirectionalDelta::default();
        for (delta, expected) in list(case, "deltas").iter().zip(list(case, "steps")) {
            let reversed = accumulate_directional_scroll_delta(&mut state, delta.as_f64().expect("a delta"));
            assert_eq!(reversed, flag(expected, "reversed"), "{case}");
            assert_eq!(state.pending_rows, number(expected, "pendingRows"), "{case}");
            assert_eq!(i64::from(state.direction), expected["direction"].as_i64().expect("direction"), "{case}");
        }
    }
}

fn scroll_from(spec: &Value) -> TranscriptScroll {
    let refs = &spec["refs"];
    let geom = if refs["geom"].is_object() {
        Geometry {
            prefix_rows: prefix(&refs["geom"], "prefixRows"),
            ids: ids(&refs["geom"], "ids"),
            total_rows: count(&refs["geom"], "totalRows"),
            view_rows: count(&refs["geom"], "viewRows"),
            render_offset: number(&refs["geom"], "renderOffset"),
        }
    } else {
        Geometry::default()
    };
    let viewport = refs["prevViewport"].is_object().then(|| Viewport {
        content_height: count(&refs["prevViewport"], "contentHeight"),
        floating_panel_rows: count(&refs["prevViewport"], "floatingPanelRows"),
    });
    TranscriptScroll {
        scroll_offset: spec["scrollOffset"].as_u64().unwrap_or(0) as usize,
        target: number(refs, "target"),
        position: number(refs, "position"),
        anchor: anchor(&refs["anchor"]),
        anchor_dirty: flag(refs, "dirty"),
        following: flag(refs, "following"),
        geom,
        viewport,
        ..TranscriptScroll::default()
    }
}

fn same_state(scroll: &TranscriptScroll, expected: &Value, context: &str) {
    assert_eq!(scroll.target, number(expected, "target"), "target: {context}");
    assert_eq!(scroll.position, number(expected, "position"), "position: {context}");
    assert_eq!(scroll.following, flag(expected, "following"), "following: {context}");
    same_anchor(&scroll.anchor, &expected["anchor"], context);
    assert_eq!(scroll.anchor_dirty, flag(expected, "dirty"), "dirty: {context}");
    assert_eq!(scroll.scroll_offset as f64, number(expected, "offset"), "offset: {context}");
}

#[test]
fn render_time_anchor_lock_matches_node() {
    for case in list(&golden(), "render") {
        let mut scroll = scroll_from(case);
        let list_ids = ids(case, "ids");
        let prefix_rows = prefix(&case["rowIndex"], "prefixRows");
        let row_index = RowIndex { total_rows: count(&case["rowIndex"], "totalRows"), prefix_rows: prefix_rows.as_deref() };
        let offset = scroll.resolve_render_scroll_offset(&list_ids, row_index, count(case, "viewRows"), count(case, "floatingPanelRows"));
        let expected = &case["expected"];
        assert_eq!(offset, number(expected, "offset"), "render offset: {case}");
        // The published offset is not touched by the render.
        assert_eq!(scroll.scroll_offset as f64, number(case, "scrollOffset"), "{case}");
        assert_eq!(scroll.target, number(expected, "target"), "{case}");
        assert_eq!(scroll.following, flag(expected, "following"), "{case}");
        same_anchor(&scroll.anchor, &expected["anchor"], &format!("{case}"));
        assert_eq!(scroll.anchor_dirty, flag(expected, "dirty"), "{case}");
        let viewport = scroll.viewport.expect("the render records its viewport");
        assert_eq!(
            (viewport.content_height as f64, viewport.floating_panel_rows as f64),
            (number(&expected["prevViewport"], "contentHeight"), number(&expected["prevViewport"], "floatingPanelRows")),
            "{case}"
        );
    }
}

#[test]
fn post_commit_reconciliation_matches_node() {
    for case in list(&golden(), "commit") {
        let mut scroll = scroll_from(case);
        let frame = &case["frame"];
        let list_ids = ids(frame, "ids");
        let prefix_rows = prefix(frame, "prefixRows");
        match case["kind"].as_str().expect("a kind") {
            "commit" => scroll.sync_reading_anchor_after_commit(&CommitFrame {
                drag_active: flag(frame, "dragActive"),
                total_rows: count(frame, "totalRows"),
                previous_total_rows: count(frame, "previousTotalRows"),
                prefix_rows: prefix_rows.as_deref(),
                ids: &list_ids,
                view_rows: count(frame, "viewRows"),
                max_rows: count(frame, "maxRows"),
            }),
            "unanchored" => scroll.reset_scroll_when_unanchored(),
            "clamp" => scroll.clamp_scroll_to_overflow(count(frame, "maxRows")),
            other => panic!("unknown kind {other}"),
        }
        same_state(&scroll, &case["expected"], &format!("{case}"));
    }
}

#[test]
fn scripted_scrolls_match_node() {
    let tuning = ScrollTuning::default();
    for case in list(&golden(), "engine") {
        let heights: Vec<usize> = list(case, "heights").iter().map(|height| height.as_u64().expect("a height") as usize).collect();
        let mut scroll = transcript(&heights, count(case, "view"));
        assert_eq!(scroll.max_scroll_rows, count(case, "maxRows"));
        let mut host = host();
        let mut coalescer = ScrollCoalescer::default();
        let mut now = 0_u64;
        for (index, (step, expected)) in list(case, "steps").iter().zip(list(case, "expected")).enumerate() {
            let context = format!("{} step {index} {step}", case["name"]);
            match step["op"].as_str().expect("an op") {
                "scroll" => scroll.scroll_rows(&mut host, number(step, "rows"), flag(step, "smooth")),
                "queue" => {
                    if let Some(rows) = coalescer.queue(number(step, "rows"), now, tuning.coalesce_ms) {
                        scroll.scroll_rows(&mut host, rows, false);
                    }
                }
                "settle" => {
                    now += step["ms"].as_u64().expect("milliseconds");
                    if let Some(rows) = coalescer.tick(now) {
                        scroll.scroll_rows(&mut host, rows, false);
                    }
                    let mut ticks = 0;
                    while scroll.glide_tick() {
                        ticks += 1;
                        assert!(ticks < 1000, "the glide lands: {context}");
                    }
                }
                "reset" => scroll.reset_transcript_scroll(),
                "arm" => scroll.arm_transcript_follow(),
                "max" => {
                    scroll.max_scroll_rows = count(step, "rows");
                    scroll.replay_pending_readback(&mut host);
                }
                "history" => {
                    host.before = flag(step, "before");
                    host.after = flag(step, "after");
                    host.restores = step.get("restores").and_then(Value::as_bool).unwrap_or(true);
                }
                "target" => scroll.target = number(step, "value"),
                other => panic!("unknown step {other}"),
            }
            same_state(&scroll, expected, &context);
            assert_eq!((host.older, host.newer), (count(expected, "olderRestores"), count(expected, "newerRestores")), "{context}");
        }
    }
}

#[test]
fn swap_reset_matches_node() {
    for case in list(&golden(), "swap") {
        let mut scroll = TranscriptScroll::default();
        let mut resets: Vec<usize> = Vec::new();
        for (step, (items, expected)) in list(case, "lists").iter().zip(list(case, "expected")).enumerate() {
            scroll.target = 5.0;
            scroll.following = false;
            scroll.swap_reset(items.as_array().expect("items"));
            if scroll.target == 0.0 && scroll.following {
                resets.push(step);
            }
            let expected: Vec<usize> = expected["resets"].as_array().expect("resets").iter().map(|at| at.as_u64().expect("a step") as usize).collect();
            assert_eq!(resets, expected, "{case} step {step}");
        }
    }
}

fn active(tools: Option<ActiveTools>) -> Value {
    let segment = |tool: Option<ActiveTool>| tool.map(|tool| json!({ "count": tool.count, "startedAt": tool.started_at }));
    tools.map_or(Value::Null, |tools| {
        let mut object = serde_json::Map::new();
        for (key, tool) in [("shell", tools.shell), ("web_search", tools.web_search), ("agent", tools.agent)] {
            if let Some(tool) = segment(tool) {
                object.insert(key.to_owned(), tool);
            }
        }
        Value::Object(object)
    })
}

/// The numbers of a value, so `2` and `2.0` compare equal.
fn numbers_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len() && left.iter().all(|(key, value)| right.get(key).is_some_and(|other| numbers_equal(value, other)))
        }
        _ => left == right,
    }
}

#[test]
fn activity_signatures_match_node() {
    for case in list(&golden(), "activity") {
        let state = &case["state"];
        let expected = &case["expected"];
        assert_eq!(agent_revision(state), expected["agentRevision"].as_str().expect("a revision"), "{state}");
        let tools = active(active_tools(&active_tools_signature(state)));
        assert!(numbers_equal(&tools, &expected["activeTools"]), "{state}: {tools} against {}", expected["activeTools"]);
        assert!(numbers_equal(&statusline_stats(state), &expected["statuslineStats"]), "{state}");
    }
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
