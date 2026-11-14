//! The frames a backend's captures issue (`observation/capture-session-stores.ts`) and frame-bound coordinates mapped to the
//! helper's (`host/input-target.ts`).

use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::Hash;
use std::hash::Hasher;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use mixdog_app_protocol::v2::host::HostComputerDisplay;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ImageData;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// How long a frame stays usable (`MAX_COMPUTER_OBSERVATION_AGE_MS`, `session/resources.ts`).
const MAX_FRAME_AGE: Duration = Duration::from_secs(60);
/// How long the latest frame stands for the session's observed scope when a step names none (`MAX_COMPUTER_OBSERVED_SCOPE_AGE_MS`):
/// a foreground step never carries the idle proof of an older capture.
const MAX_OBSERVED_SCOPE_AGE: Duration = Duration::from_secs(300);
/// The `input_idle_state` reason of a capture the user's own input overlapped (`USER_INPUT_DURING_CAPTURE`).
pub(super) const USER_INPUT_DURING_CAPTURE: &str = "user_input_during_capture";

/// The helper's `input_idle_state` taken with a capture: what a foreground input is bound to.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct InputIdle {
    pub(super) ready: bool,
    /// The observer's monitor id (`observed_input_monitor_id`), as the helper reported it.
    pub(super) monitor: Value,
    pub(super) sequence: i64,
    pub(super) reason: Option<String>,
}

/// One capture's geometry (`CaptureFrame`): its pixels map onto the physical size at the origin.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Frame {
    pub(super) id: String,
    pub(super) window_id: Option<String>,
    pub(super) related_window_ids: Option<Vec<String>>,
    pub(super) origin_x: i64,
    pub(super) origin_y: i64,
    pub(super) physical_width: i64,
    pub(super) physical_height: i64,
    pub(super) capture_width: i64,
    pub(super) capture_height: i64,
    pub(super) idle: Option<InputIdle>,
}

/// The display a frame's pixels were cut from (`CaptureFrame.displayId`, `displayX..displayHeight`): its rectangle in physical pixels
/// and its scale, as `host/computer/pixels` reported them. A zoom of a display frame keeps its parent's, which is what the frame is
/// checked against when the layout may have changed.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(not(test), expect(dead_code, reason = "display frames are issued by computer_pixels, whose caller is the wiring of the screen capture"))]
pub(super) struct DisplaySource {
    pub(super) display_id: String,
    pub(super) x: i64,
    pub(super) y: i64,
    pub(super) width: i64,
    pub(super) height: i64,
    pub(super) scale_factor: f64,
}

fn int(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64))
}

impl Frame {
    /// The frame a capture reply carries (snake_case `CaptureFrame` fields, `input_idle_state` as the helper reports it);
    /// `None` when the reply has no usable geometry.
    #[cfg_attr(not(test), expect(dead_code, reason = "core-capture-flow reads frames from capture replies"))]
    pub(super) fn from_json(value: &Value) -> Option<Frame> {
        let fields = value.as_object()?;
        let id = fields.get("id").or_else(|| fields.get("frame_id")).and_then(Value::as_str).filter(|id| !id.is_empty())?;
        let (physical_width, physical_height) = (int(fields.get("physical_width"))?, int(fields.get("physical_height"))?);
        let (capture_width, capture_height) = (int(fields.get("capture_width"))?, int(fields.get("capture_height"))?);
        if physical_width <= 0 || physical_height <= 0 || capture_width <= 0 || capture_height <= 0 {
            return None;
        }
        let idle = fields.get("input_idle_state").and_then(Value::as_object).and_then(|idle| {
            let monitor = idle.get("monitor").filter(|m| m.is_string() || m.is_number())?.clone();
            Some(InputIdle {
                ready: idle.get("ready").and_then(Value::as_bool).unwrap_or(false),
                monitor,
                sequence: int(idle.get("sequence"))?,
                reason: idle.get("reason").and_then(Value::as_str).map(str::to_string),
            })
        });
        Some(Frame {
            id: id.to_string(),
            window_id: fields.get("window_id").and_then(Value::as_str).filter(|w| !w.is_empty()).map(str::to_string),
            related_window_ids: fields
                .get("related_window_ids")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_string).collect()),
            origin_x: int(fields.get("origin_x")).unwrap_or(0),
            origin_y: int(fields.get("origin_y")).unwrap_or(0),
            physical_width,
            physical_height,
            capture_width,
            capture_height,
            idle,
        })
    }

    /// `framePoint`: a capture pixel as the physical screen pixel it covers (halves round up, as `Math.round`).
    fn point(&self, x: &Value, y: &Value) -> Result<(i64, i64), ComputerError> {
        let inside = |v: &Value, size: i64| int(Some(v)).filter(|v| (0..size).contains(v));
        let (Some(x), Some(y)) = (inside(x, self.capture_width), inside(y, self.capture_height)) else {
            return Err(refused(format!(
                "frame coordinates must be inside 0..{},0..{}",
                self.capture_width - 1,
                self.capture_height - 1
            )));
        };
        // In i128: a malformed reply's sizes cannot overflow the product.
        let scaled = |v: i64, physical: i64, capture: i64| {
            let value = (2 * i128::from(v) * i128::from(physical) + i128::from(capture)).div_euclid(2 * i128::from(capture));
            i64::try_from(value).unwrap_or(i64::MAX)
        };
        Ok((
            self.origin_x + scaled(x, self.physical_width, self.capture_width),
            self.origin_y + scaled(y, self.physical_height, self.capture_height),
        ))
    }
}

#[cfg_attr(not(test), expect(dead_code, reason = "judged by assert_display_unchanged, whose caller is the wiring of the screen capture"))]
impl DisplaySource {
    /// Whether `display` is the one this source was cut from, as it is now: its id, its origin and its size (in physical pixels, or in
    /// the host's own units where it reports points) and its scale.
    fn matches(&self, display: &HostComputerDisplay) -> bool {
        let physical = |edge: u32| (f64::from(edge) * display.scale_factor).round() as i64;
        let same_size = |edge: i64, host: u32| edge == i64::from(host) || edge == physical(host);
        display.id == self.display_id
            && i64::from(display.x) == self.x
            && i64::from(display.y) == self.y
            && same_size(self.width, display.width)
            && same_size(self.height, display.height)
            && (display.scale_factor - self.scale_factor).abs() < 1e-6
    }
}

fn refused(message: String) -> ComputerError {
    ComputerError::Failed { code: "computer_failed".into(), message }
}

/// An OCR word's click point in its frame's pixels (`ElementAliasTarget` of kind `point`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct OcrMark {
    pub(super) x: i64,
    pub(super) y: i64,
}

/// The OCR marks the latest capture published, by number, and the frame they belong to.
#[derive(Clone, Default)]
struct Marks {
    frame_id: String,
    window_id: Option<String>,
    by_number: BTreeMap<i64, OcrMark>,
}

/// A backend's frames. Its captures replace one another (`rememberLatestComputerFrame`): only the latest frame is held, with the OCR
/// marks its capture published.
#[derive(Default)]
pub(super) struct FrameStore {
    latest: Mutex<Option<(Frame, Instant)>>,
    marks: Mutex<Option<Marks>>,
    /// The last image delivered per window (`createCaptureImageDedupStore`), oldest first: the digest and the exact length.
    delivered: Mutex<Vec<(String, u64, usize)>>,
    /// The display the latest frame was cut from, under the frame's id; `None` for a window frame.
    display: Mutex<Option<(String, DisplaySource)>>,
}

/// How many windows' last images are remembered (`createCaptureImageDedupStore`'s 64).
const MAX_DELIVERED: usize = 64;

impl FrameStore {
    /// Records `image` as the last one delivered for `window_id` and reports whether it repeats the previous one
    /// (`isRepeat`). A stored blob is compared by its digest; raw bytes by a hash and the exact length.
    pub(super) fn repeats_delivered(&self, window_id: &str, image: &ImageData) -> bool {
        let (digest, length) = match image {
            ImageData::Bytes(bytes) => (hash_of(bytes), bytes.len()),
            ImageData::Blob(blob) => (hash_of(&blob), 0),
        };
        let mut delivered = locked(&self.delivered);
        let previous = delivered.iter().position(|(key, ..)| key == window_id).map(|at| delivered.remove(at));
        delivered.push((window_id.to_owned(), digest, length));
        if delivered.len() > MAX_DELIVERED {
            delivered.remove(0);
        }
        previous.is_some_and(|(_, was, size)| was == digest && size == length)
    }

    /// Forgets every window's last delivered image (`releaseCaptureSession`'s `releasePrefix` at an abort or release).
    pub(super) fn forget_delivered(&self) {
        locked(&self.delivered).clear();
    }
}

fn hash_of(value: &(impl Hash + ?Sized)) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl FrameStore {
    /// Registers a capture's frame (core-capture-flow, core-zoom); it replaces the one before, and the marks of that.
    pub(super) fn remember(&self, frame: Frame) {
        self.remember_at(frame, Instant::now());
    }

    fn remember_at(&self, frame: Frame, at: Instant) {
        *locked(&self.marks) = None;
        *locked(&self.display) = None;
        *locked(&self.latest) = Some((frame, at));
    }

    /// Forgets the frame a mutation invalidated (`invalidateActionTargets`), and its marks.
    pub(super) fn clear(&self) {
        *locked(&self.marks) = None;
        *locked(&self.display) = None;
        *locked(&self.latest) = None;
    }

    /// Registers the frame of a display capture or of a zoom of one, with the display it was cut from.
    #[cfg_attr(not(test), expect(dead_code, reason = "the capture path of a screen (the wiring of computer_pixels) issues display frames"))]
    pub(super) fn remember_display(&self, frame: Frame, source: DisplaySource) {
        let id = frame.id.clone();
        self.remember(frame);
        *locked(&self.display) = Some((id, source));
    }

    /// The display `frame_id` was cut from, when the latest frame is a display frame of that id.
    #[cfg_attr(not(test), expect(dead_code, reason = "the capture path of a screen (the wiring of computer_pixels) routes a zoom by it"))]
    pub(super) fn display_of(&self, frame_id: &str) -> Option<DisplaySource> {
        locked(&self.display).as_ref().filter(|(id, _)| id == frame_id).map(|(_, source)| source.clone())
    }

    /// `assertDisplayUnchanged` (`session/frame-validity.ts`): a display frame whose display is gone from `displays`, or has another
    /// rectangle or scale, is a stale frame, since every pixel coordinate in it would point somewhere else. The frame is forgotten, so a
    /// step that names it is refused too. A window frame, or no frame, is not judged here.
    #[cfg_attr(not(test), expect(dead_code, reason = "the act path of a screen (the wiring of computer_pixels) checks the layout before a step"))]
    pub(super) fn assert_display_unchanged(&self, displays: &[HostComputerDisplay]) -> Result<(), ComputerError> {
        let Some((id, source)) = locked(&self.display).clone() else { return Ok(()) };
        if displays.iter().any(|display| source.matches(display)) {
            return Ok(());
        }
        self.clear();
        Err(ComputerError::Failed { code: "stale_frame".into(), message: format!("stale_frame: display layout changed ({id})") })
    }

    /// Publishes the OCR marks of the latest frame (`elementTargetsFromRecords`); a mark of any other frame is not kept.
    pub(super) fn remember_marks(&self, frame: &Frame, by_number: BTreeMap<i64, OcrMark>) {
        if locked(&self.latest).as_ref().is_some_and(|(latest, _)| latest.id == frame.id) {
            *locked(&self.marks) = Some(Marks { frame_id: frame.id.clone(), window_id: frame.window_id.clone(), by_number });
        }
    }

    /// The frame `frame_id` names (`requireValidFrame`), or the latest one when none is named.
    pub(super) fn lookup(&self, frame_id: Option<&str>, now: Instant) -> Result<Option<Frame>, ComputerError> {
        let mut latest = locked(&self.latest);
        let unknown = |id: &str| refused(format!("stale_frame: unknown frame_id {id} in this session"));
        let Some((frame, at)) = latest.as_ref() else {
            return match frame_id {
                Some(id) => Err(unknown(id)),
                None => Ok(None),
            };
        };
        if frame_id.is_none() && now.saturating_duration_since(*at) > MAX_OBSERVED_SCOPE_AGE {
            *latest = None;
            return Ok(None);
        }
        if let Some(id) = frame_id {
            if frame.id != id {
                return Err(unknown(id));
            }
            if now.saturating_duration_since(*at) > MAX_FRAME_AGE {
                let message = format!("stale_frame: frame expired ({}); capture the target again", frame.id);
                *latest = None;
                return Err(refused(message));
            }
        }
        Ok(Some(frame.clone()))
    }
}

/// Actions that may name a control by its mark (`ELEMENT_ALIAS_ACTIONS`, `session/element-aliases.ts`), and those of them that can
/// act on a frame point instead (`PIXEL_ALIAS_ACTIONS`).
const ALIAS_ACTIONS: [&str; 17] = [
    "invoke", "set_value", "toggle", "click", "double_click", "right_click", "middle_click", "triple_click", "mouse_down", "mouse_up", "mouse_move", "drag",
    "type", "key", "key_down", "key_up", "scroll",
];
const POINT_ACTIONS: [&str; 11] =
    ["click", "double_click", "right_click", "middle_click", "triple_click", "mouse_down", "mouse_up", "mouse_move", "drag", "scroll", "type"];

/// `OCR_REF_PATTERN`: a capture publishes each OCR word as `ocr:<frame_id>:<mark>` in its ref.
static OCR_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ocr:(.+):(\d+)$").expect("static pattern"));

/// What an `element` or `ref` of a step names: a frame point of the latest capture, or a mark of the helper's snapshot (which the
/// helper resolves itself).
enum Named {
    Point(OcrMark),
    Semantic,
}

impl Marks {
    /// `elementTarget` and `ocrRefTarget`: `element` (a mark of this capture's OCR words, else the helper's) or an `ocr:<frame>:<mark>`
    /// ref, which only the frame the capture published may name.
    fn named(&self, step: &Map<String, Value>, element: &str, reference: &str) -> Result<Option<Named>, ComputerError> {
        if has(step, element) {
            let mark = int(step.get(element)).filter(|mark| *mark >= 1).and_then(|mark| self.by_number.get(&mark));
            return Ok(Some(mark.map_or(Named::Semantic, |mark| Named::Point(*mark))));
        }
        let value = step.get(reference).and_then(Value::as_str).unwrap_or_default();
        let Some(found) = OCR_REF.captures(value) else { return Ok(None) };
        let stale = |shown: &str| refused(format!("stale_element: {reference}={shown} is not in the latest capture for this session"));
        let number = found[2].parse::<i64>().ok().filter(|mark| *mark >= 1).ok_or_else(|| stale(&found[2]))?;
        let mark = self.by_number.get(&number).ok_or_else(|| stale(&found[2]))?;
        if self.frame_id != found[1] {
            return Err(stale(value));
        }
        Ok(Some(Named::Point(*mark)))
    }
}

/// `resolveElementAliases` for the marks only the core knows: an OCR word named by `element` / `to_element` or by an `ocr:` ref /
/// `to` becomes the frame-bound point of the latest capture (`frame_id`, `window_id`, `x`, `y`; `to_x`, `to_y` for a drag's end),
/// agreeing with what the step names besides; with no marks published, an `ocr:` ref is stale. A mark of the helper's snapshot
/// stays for the helper.
fn resolve_marks(marks: &Marks, action: &str, step: &mut Map<String, Value>) -> Result<(), ComputerError> {
    if !ALIAS_ACTIONS.contains(&action) {
        return Ok(());
    }
    let source = marks.named(step, "element", "ref")?;
    let destination = if action == "drag" { marks.named(step, "to_element", "to")? } else { None };
    let window = step.get("window_id").and_then(Value::as_str).filter(|window| !window.is_empty());
    for (target, label) in [(&source, "element"), (&destination, "to_element")] {
        if let (Some(Named::Point(_)), Some(marked), Some(window)) = (target, &marks.window_id, window)
            && marked != window
        {
            return Err(refused(format!("{label} and window_id identify different windows")));
        }
    }
    if matches!(source, Some(Named::Point(_))) && !POINT_ACTIONS.contains(&action) {
        return Err(refused(format!("OCR element marks do not support '{action}'; use a semantic ref or click the OCR mark first")));
    }
    if let (Some(source), Some(destination)) = (&source, &destination)
        && std::mem::discriminant(source) != std::mem::discriminant(destination)
    {
        return Err(refused("drag source and destination must both be semantic elements or both be OCR/frame points".into()));
    }
    if ![&source, &destination].into_iter().any(|target| matches!(target, Some(Named::Point(_)))) {
        return Ok(());
    }
    step.insert("frame_id".into(), json!(marks.frame_id));
    if let Some(window) = &marks.window_id {
        step.insert("window_id".into(), json!(window));
    }
    if let Some(Named::Point(point)) = source {
        step.remove("element");
        step.remove("ref");
        step.insert("x".into(), json!(point.x));
        step.insert("y".into(), json!(point.y));
    }
    if let Some(Named::Point(point)) = destination {
        step.remove("to_element");
        step.remove("to");
        step.insert("to_x".into(), json!(point.x));
        step.insert("to_y".into(), json!(point.y));
    }
    Ok(())
}

fn has(step: &Map<String, Value>, key: &str) -> bool {
    step.get(key).is_some_and(|v| !v.is_null())
}

/// Maps an `act` step's frame coordinates to the helper's (`resolveInputTarget`, `powerShellInputRequest`), or refuses a step on an
/// unknown frame; a foreground step carries the idle observation of the capture it was read from.
pub(super) fn map_step(frames: &FrameStore, step: &mut Map<String, Value>) -> Result<(), ComputerError> {
    map_step_at(frames, step, Instant::now())
}

fn map_step_at(frames: &FrameStore, step: &mut Map<String, Value>, now: Instant) -> Result<(), ComputerError> {
    let action = step.get("action").and_then(Value::as_str).unwrap_or_default().to_string();
    resolve_marks(&locked(&frames.marks).clone().unwrap_or_default(), &action, step)?;
    let frame_id = step.remove("frame_id").map(|id| id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string()));
    let frame_id = frame_id.filter(|id| !id.is_empty());
    // Waypoints belong to a drag only (`input-target.ts`): on any other action they would leave its x/y unmapped.
    let waypoints = if action == "drag" { step.get("waypoints").and_then(Value::as_array).cloned() } else { None };
    if action != "drag" {
        step.remove("waypoints");
    }
    if waypoints.as_ref().is_some_and(|points| points.len() < 2) {
        return Err(refused("waypoint drag requires at least two points".into()));
    }
    let pointed = ["x", "y", "to_x", "to_y"].iter().any(|key| has(step, key)) || waypoints.is_some();
    let bound = pointed && (waypoints.is_some() || !has(step, "ref"));
    if bound && frame_id.is_none() {
        return Err(refused("frame_id is required for pixel coordinates".into()));
    }
    let frame = frames.lookup(frame_id.as_deref(), now)?;
    if bound && let Some(frame) = &frame {
        bind_points(frame, &action, step, waypoints.as_deref())?;
    }
    if step.get("delivery").and_then(Value::as_str) == Some("foreground") {
        // Foreground input is bound to the idle proof of a fresh capture, or refused (`input-dispatch.ts`): without one the helper
        // would only begin a scope of its own, which knows nothing of input since the person last looked.
        let no_observation = || refused("input_observation_unavailable: capture a fresh foreground-ready observation before input".into());
        let Some(frame) = &frame else { return Err(no_observation()) };
        let Some(idle) = &frame.idle else { return Err(no_observation()) };
        if !idle.ready {
            let user = idle.reason.as_deref() == Some(USER_INPUT_DURING_CAPTURE);
            return Err(refused(format!(
                "foreground_input_not_ready: the last observation was not foreground-ready (foreground_input_reason={}); {}",
                idle.reason.as_deref().unwrap_or("unknown"),
                if user { "user input means wait for the user" } else { "an unready observer means diagnose" }
            )));
        }
        step.insert("observed_input_monitor_id".into(), idle.monitor.clone());
        step.insert("observed_input_user_sequence".into(), json!(idle.sequence));
    }
    Ok(())
}

/// The step's points in physical pixels, its window the frame's, and the frame's related windows the ones a drag may cross.
fn bind_points(frame: &Frame, action: &str, step: &mut Map<String, Value>, waypoints: Option<&[Value]>) -> Result<(), ComputerError> {
    let coordinate = |step: &Map<String, Value>, key: &str| step.get(key).cloned().unwrap_or(Value::Null);
    let (needs_window, drag) = match (action, waypoints) {
        (_, Some(_)) => (Some("waypoint drag"), true),
        ("drag", None) => (Some("coordinate drag"), true),
        ("scroll", None) => (Some("coordinate scroll"), false),
        _ => (None, false),
    };
    if let Some(points) = waypoints {
        let mapped = points
            .iter()
            .map(|point| {
                let (x, y) = frame.point(point.get("x").unwrap_or(&Value::Null), point.get("y").unwrap_or(&Value::Null))?;
                Ok(json!({"x": x, "y": y}))
            })
            .collect::<Result<Vec<_>, ComputerError>>()?;
        step.insert("waypoints".into(), Value::Array(mapped));
    } else {
        let missing = match action {
            "drag" => "drag requires ref/to or frame-bound x/y/to_x/to_y coordinates".to_string(),
            "scroll" => "coordinate scroll requires frame-bound x and y".to_string(),
            _ => format!("{action} requires ref or frame-bound x/y coordinates"),
        };
        if !has(step, "x") || !has(step, "y") || (drag && (!has(step, "to_x") || !has(step, "to_y"))) {
            return Err(refused(missing));
        }
        let (x, y) = frame.point(&coordinate(step, "x"), &coordinate(step, "y"))?;
        step.insert("x".into(), json!(x));
        step.insert("y".into(), json!(y));
        if drag {
            let (to_x, to_y) = frame.point(&coordinate(step, "to_x"), &coordinate(step, "to_y"))?;
            step.insert("to_x".into(), json!(to_x));
            step.insert("to_y".into(), json!(to_y));
        }
    }
    if let Some(window) = &frame.window_id {
        step.insert("window_id".into(), json!(window));
    } else if let Some(gesture) = needs_window
        && !has(step, "window_id")
    {
        return Err(refused(format!("{gesture} requires a window capture frame")));
    }
    let allowed = frame
        .related_window_ids
        .clone()
        .or_else(|| step.get("window_id").and_then(Value::as_str).map(|window| vec![window.to_string()]))
        .unwrap_or_default();
    step.insert("allowed_window_ids".into(), json!(allowed));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same pixels twice for one window repeat; another window, or different pixels, do not.
    #[test]
    fn a_repeated_image_is_told_apart_per_window() {
        let store = FrameStore::default();
        let png = |bytes: &[u8]| ImageData::Bytes(bytes.to_vec());
        assert!(!store.repeats_delivered("hwnd:0x1", &png(b"aaa")));
        assert!(store.repeats_delivered("hwnd:0x1", &png(b"aaa")));
        assert!(!store.repeats_delivered("hwnd:0x2", &png(b"aaa")));
        assert!(!store.repeats_delivered("hwnd:0x1", &png(b"aab")));
        assert!(!store.repeats_delivered("hwnd:0x1", &png(b"aa")));
        // An aborted or released session starts over: its next image is sent.
        store.forget_delivered();
        assert!(!store.repeats_delivered("hwnd:0x1", &png(b"aa")));
    }

    /// Only the newest 64 windows are remembered.
    #[test]
    fn the_oldest_window_is_forgotten_past_the_limit() {
        let store = FrameStore::default();
        let image = ImageData::Bytes(vec![1]);
        for n in 0..=MAX_DELIVERED {
            store.repeats_delivered(&format!("w{n}"), &image);
        }
        assert!(!store.repeats_delivered("w0", &image));
        assert!(store.repeats_delivered(&format!("w{MAX_DELIVERED}"), &image));
    }

    fn frame(id: &str) -> Frame {
        Frame {
            id: id.into(),
            window_id: Some("hwnd:0x3".into()),
            related_window_ids: Some(vec!["hwnd:0x3".into(), "hwnd:0x9".into()]),
            origin_x: -1920,
            origin_y: 100,
            physical_width: 300,
            physical_height: 200,
            capture_width: 200,
            capture_height: 100,
            idle: Some(InputIdle { ready: true, monitor: json!("m1"), sequence: 7, reason: None }),
        }
    }

    fn step(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn message(error: ComputerError) -> String {
        match error {
            ComputerError::Failed { message, .. } => message,
            other => format!("{other:?}"),
        }
    }

    fn refusal(store: &FrameStore, value: Value) -> String {
        message(map_step(store, &mut step(value)).unwrap_err())
    }

    #[test]
    fn a_scaled_frame_maps_to_physical_pixels_from_a_negative_origin() {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        let mut s = step(json!({"action":"click","x":1,"y":3,"frame_id":"frame-1"}));
        map_step(&store, &mut s).unwrap();
        // 1 * 1.5 = 1.5 rounds up to 2; 3 * 2 = 6.
        assert_eq!((s["x"].clone(), s["y"].clone()), (json!(-1918), json!(106)));
        assert_eq!(s["window_id"], "hwnd:0x3");
        assert_eq!(s["allowed_window_ids"], json!(["hwnd:0x3", "hwnd:0x9"]));
        assert!(!s.contains_key("frame_id"));
        assert!(refusal(&store, json!({"action":"click","x":200,"y":0,"frame_id":"frame-1"})).contains("inside 0..199,0..99"));
    }

    #[test]
    fn drag_endpoints_and_waypoints_share_one_frame() {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        let mut drag = step(json!({"action":"drag","x":0,"y":0,"to_x":100,"to_y":50,"frame_id":"frame-1"}));
        map_step(&store, &mut drag).unwrap();
        assert_eq!((drag["to_x"].clone(), drag["to_y"].clone()), (json!(-1770), json!(200)));
        let mut path = step(json!({"action":"drag","waypoints":[{"x":0,"y":0},{"x":2,"y":1}],"frame_id":"frame-1"}));
        map_step(&store, &mut path).unwrap();
        assert_eq!(path["waypoints"], json!([{"x":-1920,"y":100},{"x":-1917,"y":102}]));
        assert!(refusal(&store, json!({"action":"drag","x":0,"y":0,"frame_id":"frame-1"})).contains("drag requires ref/to"));
    }

    #[test]
    fn a_stale_or_expired_frame_is_refused() {
        let store = FrameStore::default();
        let click = |id: &str| json!({"action":"click","x":1,"y":1,"frame_id":id});
        assert!(refusal(&store, click("frame-9")).contains("stale_frame: unknown frame_id frame-9"));
        let at = Instant::now();
        store.remember_at(frame("frame-1"), at);
        assert!(message(map_step_at(&store, &mut step(click("frame-9")), at).unwrap_err()).contains("unknown frame_id frame-9"));
        let late = map_step_at(&store, &mut step(click("frame-1")), at + Duration::from_secs(61)).unwrap_err();
        assert!(message(late).contains("frame expired (frame-1)"));
        assert!(refusal(&store, click("frame-1")).contains("unknown frame_id"));
        assert!(refusal(&store, json!({"action":"click","x":1,"y":1})).contains("frame_id is required"));
    }

    #[test]
    fn a_new_capture_replaces_the_frame_before() {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        store.remember(frame("frame-2"));
        let click = |id: &str| json!({"action":"click","x":1,"y":1,"frame_id":id});
        assert!(refusal(&store, click("frame-1")).contains("unknown frame_id"));
        store.clear();
        assert!(refusal(&store, click("frame-2")).contains("unknown frame_id"));
    }

    #[test]
    fn foreground_steps_carry_the_observation_and_background_ones_do_not() {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        let mut fg = step(json!({"action":"click","x":1,"y":1,"delivery":"foreground","frame_id":"frame-1"}));
        map_step(&store, &mut fg).unwrap();
        assert_eq!((fg["observed_input_monitor_id"].clone(), fg["observed_input_user_sequence"].clone()), (json!("m1"), json!(7)));
        let mut bg = step(json!({"action":"click","x":1,"y":1,"delivery":"background","frame_id":"frame-1"}));
        map_step(&store, &mut bg).unwrap();
        assert!(!bg.contains_key("observed_input_monitor_id") && bg.contains_key("allowed_window_ids"));
        let mut keys = step(json!({"action":"key","keys":"Enter","delivery":"foreground"}));
        map_step(&store, &mut keys).unwrap();
        assert_eq!(keys["observed_input_user_sequence"], 7);

        let mut unready = frame("frame-3");
        unready.idle = Some(InputIdle { ready: false, monitor: json!("m1"), sequence: 8, reason: Some(USER_INPUT_DURING_CAPTURE.into()) });
        store.remember(unready);
        let click = |id: &str| json!({"action":"click","x":1,"y":1,"delivery":"foreground","frame_id":id});
        assert!(refusal(&store, click("frame-3")).contains("foreground_input_not_ready"));
        let mut none = frame("frame-4");
        none.idle = None;
        store.remember(none);
        assert!(refusal(&store, click("frame-4")).starts_with("input_observation_unavailable: capture a fresh foreground-ready"));
        // No frame at all: a foreground key is refused, never sent without an idle proof.
        store.clear();
        let key = json!({"action":"key","keys":"Enter","delivery":"foreground"});
        assert!(refusal(&store, key.clone()).starts_with("input_observation_unavailable"));
        // The latest frame stands for the observed scope 300 s; a foreground step after that is refused too.
        let at = Instant::now();
        store.remember(frame("frame-5"));
        let mut late = step(key);
        let error = map_step_at(&store, &mut late, at + Duration::from_secs(301)).unwrap_err();
        assert!(format!("{error:?}").contains("input_observation_unavailable"), "{error:?}");
    }

    #[test]
    fn waypoints_bind_only_a_drag_of_two_or_more_points() {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        let mut click = step(json!({"action":"click","x":10,"y":20,"frame_id":"frame-1","waypoints":[{"x":1,"y":1},{"x":2,"y":2}]}));
        map_step(&store, &mut click).unwrap();
        assert!(!click.contains_key("waypoints"));
        assert_eq!((click["x"].clone(), click["y"].clone()), (json!(-1905), json!(140)));
        let empty = json!({"action":"drag","x":10,"y":20,"to_x":30,"to_y":40,"frame_id":"frame-1","waypoints":[]});
        assert!(refusal(&store, empty).contains("waypoint drag requires at least two points"));
    }

    fn marked_store() -> FrameStore {
        let store = FrameStore::default();
        store.remember(frame("frame-1"));
        store.remember_marks(&frame("frame-1"), BTreeMap::from([(4, OcrMark { x: 1, y: 3 }), (5, OcrMark { x: 100, y: 50 })]));
        store
    }

    #[test]
    fn an_ocr_mark_or_ref_resolves_to_a_frame_point_of_its_capture() {
        let store = marked_store();
        let mut by_element = step(json!({"action":"click","element":4}));
        map_step(&store, &mut by_element).unwrap();
        assert_eq!((by_element["x"].clone(), by_element["y"].clone()), (json!(-1918), json!(106)));
        assert!(!by_element.contains_key("element") && by_element["window_id"] == "hwnd:0x3");
        let mut by_ref = step(json!({"action":"double_click","ref":"ocr:frame-1:4"}));
        map_step(&store, &mut by_ref).unwrap();
        assert_eq!((by_ref["x"].clone(), by_ref.contains_key("ref")), (json!(-1918), false));
        let mut drag = step(json!({"action":"drag","element":4,"to":"ocr:frame-1:5"}));
        map_step(&store, &mut drag).unwrap();
        assert_eq!((drag["to_x"].clone(), drag["to_y"].clone(), drag.contains_key("to")), (json!(-1770), json!(200), false));
    }

    #[test]
    fn a_stale_mark_or_frame_is_refused_with_the_models_text() {
        let store = marked_store();
        assert!(refusal(&store, json!({"action":"click","ref":"ocr:frame-1:9"})).contains("stale_element: ref=9 is not in the latest capture for this session"));
        assert!(refusal(&store, json!({"action":"click","ref":"ocr:frame-0:4"})).contains("stale_element: ref=ocr:frame-0:4 is not in the latest"));
        assert!(refusal(&store, json!({"action":"drag","element":4,"to":"ocr:frame-1:9"})).contains("stale_element: to=9"));
        store.remember(frame("frame-2"));
        assert!(refusal(&store, json!({"action":"click","ref":"ocr:frame-1:4"})).contains("stale_element"));
        // A mark the core does not hold belongs to the helper's snapshot, and a plain ref is the helper's too.
        let mut semantic = step(json!({"action":"click","element":2,"ref":"ocr:frame-1:4"}));
        map_step(&marked_store(), &mut semantic).unwrap();
        assert!(semantic["element"] == 2 && semantic.contains_key("ref") && !semantic.contains_key("x"));
    }

    #[test]
    fn marks_agree_with_the_window_the_action_and_the_other_end() {
        let store = marked_store();
        assert!(refusal(&store, json!({"action":"click","element":4,"window_id":"hwnd:0x9"})).contains("element and window_id identify different windows"));
        assert!(refusal(&store, json!({"action":"invoke","element":4})).contains("OCR element marks do not support 'invoke'"));
        assert!(refusal(&store, json!({"action":"drag","element":4,"to_element":2})).contains("both be semantic elements or both be OCR/frame points"));
        let mut other = step(json!({"action":"mouse_move","ref":"ocr:frame-1:5","window_id":"hwnd:0x3"}));
        map_step(&store, &mut other).unwrap();
        assert_eq!(other["y"], 200);
        let mut plain = step(json!({"action":"click","ref":"s1:e0"}));
        map_step(&store, &mut plain).unwrap();
        assert_eq!(plain["ref"], "s1:e0");
    }

    #[test]
    fn a_new_capture_or_a_mutation_drops_the_marks() {
        let store = marked_store();
        store.remember(frame("frame-1"));
        let mut click = step(json!({"action":"click","element":4}));
        map_step(&store, &mut click).unwrap();
        assert!(click.contains_key("element"), "the helper's snapshot answers a mark this capture did not publish");
        let store = marked_store();
        store.remember_marks(&frame("frame-7"), BTreeMap::from([(4, OcrMark { x: 0, y: 0 })]));
        store.clear();
        assert!(refusal(&store, json!({"action":"click","ref":"ocr:frame-1:4"})).contains("stale_element: ref=4"));
    }

    #[test]
    fn a_capture_reply_becomes_a_frame() {
        let reply = json!({"id":"frame-5","window_id":"hwnd:0x3","origin_x":10,"origin_y":-4,"physical_width":300,"physical_height":200,
            "capture_width":150,"capture_height":100,"input_idle_state":{"ready":true,"monitor":3,"sequence":12}});
        let frame = Frame::from_json(&reply).unwrap();
        assert_eq!((frame.origin_y, frame.idle.unwrap().sequence), (-4, 12));
        assert!(Frame::from_json(&json!({"id":"f","physical_width":0})).is_none());
    }

    fn display(id: &str, x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> HostComputerDisplay {
        HostComputerDisplay { index: 0, id: id.into(), primary: true, scale_factor, width, height, x, y }
    }

    /// A display frame of a 3000x1500 physical display at (-3000, 0) shown at 1500x750, with the display it was cut from.
    fn display_store() -> FrameStore {
        let store = FrameStore::default();
        let mut shown = frame("frame-d");
        (shown.window_id, shown.related_window_ids) = (None, None);
        (shown.origin_x, shown.origin_y, shown.physical_width, shown.physical_height, shown.capture_width, shown.capture_height) = (-3000, 0, 3000, 1500, 1500, 750);
        store.remember_display(shown, DisplaySource { display_id: "7".into(), x: -3000, y: 0, width: 3000, height: 1500, scale_factor: 2.0 });
        store
    }

    #[test]
    fn a_display_frame_maps_clicks_and_is_found_by_its_id() {
        let store = display_store();
        let mut click = step(json!({"action":"click","x":750,"y":375,"frame_id":"frame-d"}));
        map_step(&store, &mut click).unwrap();
        assert_eq!((click["x"].clone(), click["y"].clone(), click.contains_key("window_id")), (json!(-1500), json!(750), false));
        assert_eq!(store.display_of("frame-d").map(|source| source.scale_factor), Some(2.0));
        assert!(store.display_of("frame-x").is_none());
        // A window capture after it is no display frame.
        store.remember(frame("frame-w"));
        assert!(store.display_of("frame-d").is_none() && store.display_of("frame-w").is_none());
    }

    /// The layout the frame was cut from still stands: the same display at the same rectangle and scale. A display that moved, resized,
    /// rescaled or went away makes the frame stale, and a click that names it is refused.
    #[test]
    fn a_click_on_a_display_frame_after_the_layout_changed_is_refused() {
        let same = [display("6", 0, 0, 800, 600, 1.0), display("7", -3000, 0, 1500, 750, 2.0)];
        let store = display_store();
        store.assert_display_unchanged(&same).unwrap();
        assert!(store.lookup(Some("frame-d"), Instant::now()).unwrap().is_some());
        for changed in [
            vec![display("7", -2000, 0, 1500, 750, 2.0)],
            vec![display("7", -3000, 0, 1600, 750, 2.0)],
            vec![display("7", -3000, 0, 1500, 750, 1.0)],
            vec![display("6", 0, 0, 800, 600, 1.0)],
            Vec::new(),
        ] {
            let store = display_store();
            let error = store.assert_display_unchanged(&changed).unwrap_err();
            assert_eq!(error, ComputerError::Failed { code: "stale_frame".into(), message: "stale_frame: display layout changed (frame-d)".into() });
            assert!(refusal(&store, json!({"action":"click","x":1,"y":1,"frame_id":"frame-d"})).starts_with("stale_frame: unknown frame_id frame-d"));
        }
        // A window frame is not judged by the display list.
        let store = FrameStore::default();
        store.remember(frame("frame-w"));
        store.assert_display_unchanged(&[]).unwrap();
        assert!(store.lookup(Some("frame-w"), Instant::now()).unwrap().is_some());
    }

    /// Where the host reports points (macOS) the rectangle is the display's own size, not scaled.
    #[test]
    fn a_host_that_reports_points_matches_an_unscaled_frame() {
        let store = FrameStore::default();
        let mut shown = frame("frame-m");
        shown.window_id = None;
        store.remember_display(shown, DisplaySource { display_id: "1".into(), x: 0, y: 0, width: 1440, height: 900, scale_factor: 2.0 });
        store.assert_display_unchanged(&[display("1", 0, 0, 1440, 900, 2.0)]).unwrap();
    }
}
