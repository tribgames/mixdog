//! Owner: s4-engine-refset
//! Coordinates read off a screenshot are accepted only while that screenshot still describes the page: the same snapshot
//! id, taken recently, the same document revision, and an unchanged URL and viewport (`ref-visual-grounding.ts`).
//! Anything else is refused rather than scaled onto a page that has moved on.
//!
//! The checks here are pure; the caller reads the page (the current revision, the URL and viewport) through the host and
//! runs them in order: [`VisualGrounding::check_current`], [`VisualGrounding::image_point`], then
//! [`VisualGrounding::check_page`], and last [`VisualGrounding::css_point`].

use std::time::Duration;
use std::time::Instant;

use super::ref_set::RefSet;

/// How long a screenshot keeps describing the page.
pub const VISUAL_GROUNDING_TTL: Duration = Duration::from_millis(30_000);

/// The screenshot a coordinate action is allowed to be expressed in.
#[derive(Debug, Clone, PartialEq)]
pub struct VisualGrounding {
    pub snapshot_id: String,
    pub revision: Option<u32>,
    pub captured_at: Instant,
    pub url: String,
    pub image_width: f64,
    pub image_height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

/// Why a coordinate was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroundingRefused {
    pub message: String,
    /// The grounding no longer describes the page: the holder drops it (the next coordinate action needs a fresh snapshot).
    pub drop_grounding: bool,
}

impl std::fmt::Display for GroundingRefused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.message)
    }
}

impl std::error::Error for GroundingRefused {}

fn refused(message: String, drop_grounding: bool) -> GroundingRefused {
    GroundingRefused { message, drop_grounding }
}

impl VisualGrounding {
    /// `bindVisualGrounding`: the screenshot of `capture_width` x `capture_height` taken with this snapshot's refs.
    pub fn bind(ref_set: &RefSet, capture_width: f64, capture_height: f64, now: Instant) -> Self {
        Self {
            snapshot_id: ref_set.snapshot_id.clone(),
            revision: ref_set.revision,
            captured_at: now,
            url: ref_set.url.clone(),
            image_width: capture_width,
            image_height: capture_height,
            viewport_width: ref_set.viewport_width,
            viewport_height: ref_set.viewport_height,
        }
    }

    /// Age of the screenshot.
    pub fn age(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.captured_at)
    }

    /// The grounding the command names, still within its lifetime and revision. `current_revision` is the page's document
    /// revision now, when the host reports one.
    pub fn check_current(&self, command_snapshot_id: Option<&str>, now: Instant, current_revision: Option<u32>, label: &str) -> Result<(), GroundingRefused> {
        if command_snapshot_id.is_none_or(|id| id.is_empty() || id != self.snapshot_id) {
            return Err(refused(format!("{label} requires snapshotId from the latest snapshot(mode=both) or locate result"), false));
        }
        if self.age(now) > VISUAL_GROUNDING_TTL || current_revision.is_some_and(|current| self.revision != Some(current)) {
            return Err(refused(format!("{label} visual grounding is stale; take a fresh snapshot(mode=both)"), true));
        }
        Ok(())
    }

    /// A screenshot coordinate that is finite and inside the screenshot.
    pub fn image_point(&self, x: f64, y: f64, label: &str) -> Result<(f64, f64), GroundingRefused> {
        if !x.is_finite() || !y.is_finite() {
            return Err(refused(format!("{label} requires finite screenshot x and y coordinates"), false));
        }
        if x < 0.0 || y < 0.0 || x >= self.image_width || y >= self.image_height {
            return Err(refused(
                format!("{label} coordinates must be inside the {}x{} screenshot", self.image_width, self.image_height),
                false,
            ));
        }
        Ok((x, y))
    }

    /// The page still has the URL and viewport of the screenshot.
    pub fn check_page(&self, url: &str, width: f64, height: f64, label: &str) -> Result<(), GroundingRefused> {
        if url != self.url || width != self.viewport_width || height != self.viewport_height {
            return Err(refused(
                format!("{label} visual grounding is stale because the page or viewport changed; call snapshot with mode=both again"),
                true,
            ));
        }
        Ok(())
    }

    /// A screenshot coordinate as a CSS point in the viewport.
    pub fn css_point(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.viewport_width / self.image_width, y * self.viewport_height / self.image_height)
    }
}

#[cfg(test)]
mod tests {
    use super::super::ref_set::tests::element;
    use super::super::ref_set::tests::payload;
    use super::*;

    fn grounding(now: Instant) -> VisualGrounding {
        let set = RefSet::from_payload("p1-s2", &payload("p1-s2", vec![element("p1-s2-e1", "button", "Go")], "https://a.test/")).with_document("d1", 7);
        VisualGrounding::bind(&set, 640.0, 450.0, now)
    }

    #[test]
    fn the_grounding_a_command_names_is_current_within_its_lifetime_and_revision() {
        let now = Instant::now();
        let held = grounding(now);
        assert_eq!(held.check_current(Some("p1-s2"), now + Duration::from_secs(29), Some(7), "click"), Ok(()));
        let other = held.check_current(Some("p1-s1"), now, Some(7), "click").unwrap_err();
        assert!(other.message.contains("requires snapshotId") && !other.drop_grounding);
        assert!(held.check_current(None, now, None, "click").is_err());
        let old = held.check_current(Some("p1-s2"), now + Duration::from_secs(31), Some(7), "click").unwrap_err();
        assert!(old.message.contains("stale") && old.drop_grounding);
        assert!(held.check_current(Some("p1-s2"), now, Some(8), "click").unwrap_err().drop_grounding);
        assert_eq!(held.check_current(Some("p1-s2"), now, None, "click"), Ok(()));
    }

    #[test]
    fn a_coordinate_must_be_finite_and_inside_the_screenshot() {
        let held = grounding(Instant::now());
        assert_eq!(held.image_point(10.0, 20.0, "click"), Ok((10.0, 20.0)));
        assert!(held.image_point(f64::NAN, 1.0, "click").unwrap_err().message.contains("finite"));
        assert!(held.image_point(640.0, 1.0, "click").unwrap_err().message.contains("inside the 640x450 screenshot"));
        assert!(held.image_point(-1.0, 1.0, "click").is_err());
    }

    #[test]
    fn a_moved_page_or_viewport_refuses_and_a_point_scales_to_the_viewport() {
        let held = grounding(Instant::now());
        assert_eq!(held.check_page("https://a.test/", 1280.0, 900.0, "click"), Ok(()));
        assert!(held.check_page("https://a.test/x", 1280.0, 900.0, "click").unwrap_err().drop_grounding);
        assert!(held.check_page("https://a.test/", 1000.0, 900.0, "click").is_err());
        assert_eq!(held.css_point(320.0, 225.0), (640.0, 450.0));
    }
}
