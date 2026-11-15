//! The wheel half of the mouse channel (`mouse-input/wheel-router.mjs`). Ctrl+wheel is handed to the terminal's own font zoom
//! after settling any in-flight drag, an open slash palette consumes the notch as list navigation, an overlay can block global
//! transcript scroll, and everything else becomes an accelerated transcript scroll.

use mixdog_term::{MouseKind, MouseReport};

use crate::slash::commands::overlay_blocks_global_transcript_scroll;

use super::state::Point;
use super::{Mouse, MouseHost};

impl Mouse {
    /// `routeWheelEvent`: one wheel notch. `report.ctrl` is the ctrl bit of the SGR button byte (an X10 wheel report carries
    /// none).
    pub fn route_wheel<H: MouseHost + ?Sized>(&mut self, report: &MouseReport, host: &mut H, now_ms: u64) {
        // +1 is wheel up (toward older rows), -1 wheel down.
        let wheel_dir = match report.kind {
            MouseKind::WheelUp => 1,
            MouseKind::WheelDown => -1,
            _ => return,
        };
        if report.ctrl {
            // The zoom passthrough disables mouse tracking for about 700 ms, during which the button release may never
            // arrive, leaving the drag stuck active and the edge autoscroll firing forever. The in-flight drag is finalized
            // from its last known point (the path of a real release, so Ctrl+C still copies the full text), then the wheel
            // goes to the terminal's font zoom.
            if self.drag.active {
                let last = self.drag.last.unwrap_or(Point { x: 0, y: 0 });
                self.finalize_active_drag(host, last.x, last.y, now_ms);
                self.finish_windows_mouse_gesture(host);
            } else {
                self.stop_edge_autoscroll();
            }
            host.passthrough_ctrl_wheel_zoom();
            return;
        }
        let palette = host.slash_palette();
        if !self.drag.active && palette.open && palette.count > 0 {
            host.step_slash_index(wheel_dir, palette.count);
            return;
        }
        if overlay_blocks_global_transcript_scroll(host.overlay_owner()) {
            return;
        }
        // A wheel while a selection is live (mid-drag or after release) scrolls the transcript instead of being dropped: the
        // scroll rebuilds the rect of an active drag, shifts a released one, and stitch-harvests the rows that scroll off.
        let rows = self.wheel.notch(wheel_dir, now_ms, &self.cfg.tuning);
        host.queue_scroll_coalesced(self, rows as f64);
    }
}
