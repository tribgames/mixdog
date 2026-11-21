use mixdog_tui_widgets::transcript::tool_failures::should_suppress_fully_failed_tool_item;
use serde_json::Value;

use super::heights::item_kind;
use super::render_window::RenderWindow;
use super::row_index::Items;

/// `visibleTranscriptItems`: the mounted items of the window.
pub fn visible_transcript_items<'a>(items: &Items<'a>, window: &RenderWindow) -> Vec<&'a Value> {
    (window.start_index..window.end_index.min(items.len())).filter_map(|at| items.get(at)).collect()
}

/// Where the overlay hint of the prompt attaches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverlayHint {
    /// The last mounted item that is drawn (a suppressed failed tool batch is skipped), if any.
    pub attach_item_index: Option<usize>,
    /// The view is at the live tail.
    pub tail_pinned: bool,
    /// The hint is drawn on the last item's row.
    pub on_last_item: bool,
    /// The hint has no item to attach to and is drawn in the guard row.
    pub fallback_row: bool,
}

/// `overlayHintPlacement` over the mounted items.
pub fn overlay_hint_placement(
    rendered: &[&Value],
    window: &RenderWindow,
    overlay_hint_requested: bool,
    floating_panel_rows: usize,
    transcript_guard_rows: usize,
) -> OverlayHint {
    let attach_item_index = rendered.iter().rposition(|item| !(item_kind(item) == "tool" && should_suppress_fully_failed_tool_item(item)));
    let tail_pinned = window.effective_scroll_offset == 0;
    let on_last_item = overlay_hint_requested && floating_panel_rows == 0 && window.bottom_spacer_rows == 0 && tail_pinned && attach_item_index.is_some();
    let fallback_row = overlay_hint_requested && floating_panel_rows == 0 && transcript_guard_rows > 0 && !on_last_item;
    OverlayHint { attach_item_index, tail_pinned, on_last_item, fallback_row }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn window(offset: usize, spacer: usize) -> RenderWindow {
        RenderWindow { start_index: 1, end_index: 3, bottom_spacer_rows: spacer, total_rows: 10, max_scroll_rows: 4, effective_scroll_offset: offset }
    }

    #[test]
    fn the_slice_is_the_window_of_the_items_with_the_live_tail() {
        let settled: Vec<Value> = (0..3).map(|n| json!({"id": format!("u{n}"), "kind": "user"})).collect();
        let tail = json!({"id": "a", "kind": "assistant", "streaming": true, "text": "now"});
        let items = Items::new(&settled, Some(&tail));
        let slice = visible_transcript_items(&items, &RenderWindow { end_index: 4, ..window(0, 0) });
        assert_eq!(slice.len(), 3);
        assert_eq!(slice[2]["text"], "now");
    }

    #[test]
    fn the_hint_attaches_to_the_last_drawn_item_at_the_tail() {
        let user = json!({"id": "u", "kind": "user"});
        let hint = overlay_hint_placement(&[&user, &user], &window(0, 0), true, 0, 0);
        assert!(hint.tail_pinned);
        assert_eq!(hint.attach_item_index, Some(1));
        assert!(hint.on_last_item);
        assert!(!hint.fallback_row);
    }

    #[test]
    fn a_scrolled_view_a_panel_or_a_spacer_keeps_the_hint_off_the_item() {
        let user = json!({"id": "u", "kind": "user"});
        assert!(!overlay_hint_placement(&[&user], &window(3, 0), true, 0, 2).on_last_item);
        assert!(overlay_hint_placement(&[&user], &window(3, 0), true, 0, 2).fallback_row);
        assert!(!overlay_hint_placement(&[&user], &window(0, 4), true, 0, 0).on_last_item);
        assert!(!overlay_hint_placement(&[&user], &window(0, 0), true, 2, 2).on_last_item);
        assert!(!overlay_hint_placement(&[&user], &window(0, 0), true, 2, 2).fallback_row);
        assert!(!overlay_hint_placement(&[&user], &window(0, 0), false, 0, 2).on_last_item);
        assert_eq!(overlay_hint_placement(&[], &window(0, 0), true, 0, 2).attach_item_index, None);
        assert!(overlay_hint_placement(&[], &window(0, 0), true, 0, 2).fallback_row);
    }
}
